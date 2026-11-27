import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import nodemailer from 'nodemailer';
import type { Env } from './config/env';
import { criarPrisma } from './config/prisma';
import type { CasosDeUso, EstadoDependencia } from './app';
import type { Logger } from './domain/portas/logger';
import { relogioDoSistema } from './domain/portas/relogio';
import { cacheDesligado } from './domain/portas/cache';
import { EXCHANGE_VIDEOS, ORIGEM_API, TIPOS } from './domain/mensageria/contratos';
import { PrismaVideoRepository } from './infrastructure/database/prisma-video.repository';
import { S3Armazenamento } from './infrastructure/armazenamento/s3-armazenamento';
import { RedisCache } from './infrastructure/cache/redis-cache';
import { RabbitMQ } from './infrastructure/mensageria/rabbitmq';
import { OutboxRelay } from './infrastructure/mensageria/outbox-relay';
import {
  EmailNotificador,
  notificadorDesligado,
} from './infrastructure/notificacao/email-notificador';
import { SolicitarEnvioUseCase } from './application/use-cases/solicitar-envio.use-case';
import { ConfirmarEnvioUseCase } from './application/use-cases/confirmar-envio.use-case';
import { ListarVideosUseCase } from './application/use-cases/listar-videos.use-case';
import { ObterVideoUseCase } from './application/use-cases/obter-video.use-case';
import { GerarDownloadUseCase } from './application/use-cases/gerar-download.use-case';
import {
  CONSUMIDOR_RESULTADOS,
  ProcessarResultadoUseCase,
} from './application/use-cases/processar-resultado.use-case';

/** Raiz de composição: o único lugar que conhece as implementações concretas. */
export function montarContainer(env: Env, logger: Logger) {
  const prisma = criarPrisma(env.DATABASE_URL);
  const ids = { novo: randomUUID };
  const videos = new PrismaVideoRepository(prisma);

  const redis = env.REDIS_URL
    ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
    : null;
  redis?.on('error', (erro) =>
    logger.warn(
      { evento: 'falha_integracao', integracao: 'redis', erro: erro.message },
      'Redis indisponível',
    ),
  );
  const cache = redis ? new RedisCache(redis, logger) : cacheDesligado;

  const armazenamento = new S3Armazenamento({
    bucket: env.S3_BUCKET,
    regiao: env.AWS_REGION,
    endpoint: env.S3_ENDPOINT,
    endpointPublico: env.S3_ENDPOINT_PUBLICO,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ttlSegundos: env.URL_ASSINADA_TTL_SEGUNDOS,
  });

  const notificador = env.SMTP_HOST
    ? new EmailNotificador(
        nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_PORT === 465,
          auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        }),
        env.SMTP_FROM,
      )
    : notificadorDesligado;

  const casos: CasosDeUso = {
    solicitarEnvio: new SolicitarEnvioUseCase(
      videos,
      armazenamento,
      cache,
      ids,
      relogioDoSistema,
      env.VIDEO_TAMANHO_MAXIMO_MB * 1024 * 1024,
      // A janela da cota é o TTL da URL: envio mais antigo que isso já não pode ser concluído.
      { maximo: env.VIDEO_ENVIOS_PENDENTES_MAX, janelaSegundos: env.URL_ASSINADA_TTL_SEGUNDOS },
    ),
    confirmarEnvio: new ConfirmarEnvioUseCase(videos, armazenamento, cache, ids, relogioDoSistema),
    listarVideos: new ListarVideosUseCase(videos, cache),
    obterVideo: new ObterVideoUseCase(videos),
    gerarDownload: new GerarDownloadUseCase(videos, armazenamento),
  };

  const mensageria = env.RABBITMQ_URL
    ? new RabbitMQ({
        url: env.RABBITMQ_URL,
        exchange: EXCHANGE_VIDEOS,
        servico: ORIGEM_API,
        maxTentativas: env.MENSAGERIA_MAX_TENTATIVAS,
        atrasoRetentativaMs: env.MENSAGERIA_ATRASO_RETENTATIVA_MS,
        logger,
      })
    : null;

  const processarResultado = new ProcessarResultadoUseCase(
    videos,
    notificador,
    cache,
    relogioDoSistema,
    logger,
  );
  mensageria?.registrar({
    fila: CONSUMIDOR_RESULTADOS,
    bindings: [TIPOS.PROCESSAMENTO_INICIADO, TIPOS.PROCESSADO, TIPOS.FALHOU],
    prefetch: 20,
    tratar: (bruto) => processarResultado.execute(bruto),
  });

  const relay = mensageria
    ? new OutboxRelay(prisma, mensageria, logger, {
        intervaloMs: env.OUTBOX_INTERVALO_MS,
        lote: 50,
        retencaoHoras: 72,
      })
    : null;

  const prontidao = async (): Promise<Record<string, EstadoDependencia>> => {
    let banco: EstadoDependencia = 'ok';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      banco = 'indisponivel';
    }
    return {
      banco,
      mensageria: mensageria ? (mensageria.conectado ? 'ok' : 'indisponivel') : 'desligada',
    };
  };

  return {
    casos,
    prontidao,
    /** Exposto para o rate limit dividir o contador entre réplicas (null sem REDIS_URL). */
    redis,
    async iniciarMensageria() {
      if (!mensageria || !relay) {
        logger.warn({ evento: 'mensageria_desligada' }, 'RABBITMQ_URL ausente: o outbox acumula');
        return;
      }
      await mensageria.conectar();
      relay.iniciar();
    },
    async encerrar() {
      await relay?.parar();
      await mensageria?.encerrar();
      redis?.disconnect();
      await prisma.$disconnect();
    },
  };
}
