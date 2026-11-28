import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { AppError, TooManyRequestsError } from './shared/errors';
import { autenticacao } from './presentation/http/plugins/autenticacao';
import { videosRoutes } from './presentation/http/routes/videos.routes';
import type { SolicitarEnvioUseCase } from './application/use-cases/solicitar-envio.use-case';
import type { ConfirmarEnvioUseCase } from './application/use-cases/confirmar-envio.use-case';
import type { ListarVideosUseCase } from './application/use-cases/listar-videos.use-case';
import type { ObterVideoUseCase } from './application/use-cases/obter-video.use-case';
import type { GerarDownloadUseCase } from './application/use-cases/gerar-download.use-case';

export interface CasosDeUso {
  solicitarEnvio: Pick<SolicitarEnvioUseCase, 'execute'>;
  confirmarEnvio: Pick<ConfirmarEnvioUseCase, 'execute'>;
  listarVideos: Pick<ListarVideosUseCase, 'execute'>;
  obterVideo: Pick<ObterVideoUseCase, 'execute'>;
  gerarDownload: Pick<GerarDownloadUseCase, 'execute'>;
}

export type EstadoDependencia = 'ok' | 'indisponivel' | 'desligada';

export interface OpcoesApp {
  casos: CasosDeUso;
  jwt: {
    segredo: string;
    emissor: string;
    /** Claim `aud` exigido; opcional até o emissor passar a enviá-lo. */
    audiencia?: string;
    /** Teto de validade (exp - agora) aceito, em segundos. */
    validadeMaximaSegundos?: number;
  };
  /** Verifica as dependências para o readiness probe do Kubernetes. */
  prontidao?: () => Promise<Record<string, EstadoDependencia>>;
  log?: { nivel: string } | false;
  swagger?: boolean;
  origensPermitidas?: string[];
  limitePorMinuto?: number;
  /**
   * Quais proxies são confiáveis para ler o IP real em `X-Forwarded-For`.
   * Sem isso, atrás do Load Balancer todo cliente "tem" o IP do LB e o rate
   * limit vira um limite global (um atacante bloqueia todos). Nunca use `true`
   * se a API puder ser acessada sem passar pelo proxy: o cliente forjaria o IP.
   */
  trustProxy?: boolean | number | string[];
  /**
   * Redis compartilhado pelo rate limit. Sem ele, cada réplica conta sozinha e o
   * limite real vira `limitePorMinuto × réplicas`.
   */
  redisRateLimit?: Redis;
}

/** Formato aceito para o `x-request-id` vindo do cliente; o resto ganha um UUID novo. */
const FORMATO_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Cabeçalhos de segurança enviados em todas as respostas. */
const CABECALHOS_SEGURANCA: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  // Navegadores ignoram HSTS em HTTP puro, então é seguro mandar sempre.
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

/**
 * Respostas JSON da API: nada pode ser executado nem embutido, e nada vai para
 * cache. As respostas trazem URLs assinadas e dados do usuário, que não devem
 * ficar guardados em proxies ou no disco do navegador.
 */
const CABECALHOS_API: Record<string, string> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cache-control': 'no-store',
};

export async function buildApp(opcoes: OpcoesApp): Promise<FastifyInstance> {
  const app = Fastify({
    // O Fastify aceita número de saltos em tempo de execução (lib/request.js), mas a
    // tipagem da v5 omite `number`; a conversão só ajusta o tipo.
    trustProxy: (opcoes.trustProxy ?? false) as boolean | string | string[],
    logger: opcoes.log
      ? {
          level: opcoes.log.nivel,
          base: { service: 'fiapx-video-api', version: process.env.APP_VERSION ?? 'dev' },
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie'],
            censor: '[REDACTED]',
          },
        }
      : false,
    genReqId(req) {
      // O id vai para os logs e volta na resposta. Restringir o formato impede
      // poluir os logs ou forjar a correlação com valores arbitrários.
      const id = req.headers['x-request-id'];
      return typeof id === 'string' && FORMATO_REQUEST_ID.test(id) ? id : randomUUID();
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (req, rep, payload) => {
    rep.header('x-request-id', req.id);
    rep.headers(CABECALHOS_SEGURANCA);
    // O Swagger UI precisa de scripts e estilos próprios; a CSP restritiva e o
    // no-store valem para o resto, que só devolve JSON.
    if (!req.url.startsWith('/docs')) rep.headers(CABECALHOS_API);
    return payload;
  });

  const origens = opcoes.origensPermitidas ?? [];
  await app.register(fastifyCors, {
    origin: origens.length > 0 ? origens : false,
    exposedHeaders: ['x-request-id'],
  });
  await app.register(fastifyRateLimit, {
    max: opcoes.limitePorMinuto ?? 120,
    timeWindow: '1 minute',
    // Com Redis, todas as réplicas dividem o mesmo contador.
    ...(opcoes.redisRateLimit
      ? { redis: opcoes.redisRateLimit, nameSpace: 'fiapx-video-api:rate-limit:' }
      : {}),
    // Redis fora do ar não derruba a API: a requisição passa sem ser contada,
    // a mesma escolha do cache (RedisCache). Fica registrado no log do Redis.
    skipOnError: true,
    errorResponseBuilder: () => new TooManyRequestsError('Muitas requisições; tente em instantes'),
  });
  await app.register(autenticacao, opcoes.jwt);

  if (opcoes.swagger) {
    await app.register(fastifySwagger, {
      transform: jsonSchemaTransform,
      openapi: {
        info: {
          title: 'FIAP X — Video API',
          version: '0.1.0',
          description: 'Envio de vídeos, acompanhamento do processamento e download dos frames.',
        },
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        },
        tags: [{ name: 'Vídeos' }, { name: 'Saúde' }],
      },
    });
    await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

  app.setErrorHandler<FastifyError>((erro, req, rep) => {
    if (erro instanceof AppError) {
      req.log.warn({ evento: 'erro_negocio', codigo: erro.code }, erro.message);
      return rep
        .status(erro.statusCode)
        .send({ statusCode: erro.statusCode, code: erro.code, message: erro.message });
    }
    if (erro.validation) {
      return rep.status(422).send({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos',
        errors: erro.validation.map((v) => ({
          campo: v.instancePath.replace(/^\//, '').replaceAll('/', '.'),
          mensagem: v.message,
        })),
      });
    }
    if (erro.statusCode && erro.statusCode < 500) {
      return rep.status(erro.statusCode).send({
        statusCode: erro.statusCode,
        code: erro.code ?? 'BAD_REQUEST',
        message: erro.message,
      });
    }
    req.log.error({ evento: 'erro_interno', err: erro }, 'erro não tratado');
    return rep
      .status(500)
      .send({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Erro interno do servidor' });
  });

  app.get('/health', { schema: { tags: ['Saúde'], summary: 'Liveness' } }, async () => ({
    status: 'ok',
  }));

  app.get(
    '/health/ready',
    { schema: { tags: ['Saúde'], summary: 'Readiness' } },
    async (_req, rep) => {
      const dependencias = (await opcoes.prontidao?.()) ?? {};
      const pronto = !Object.values(dependencias).includes('indisponivel');
      return rep
        .status(pronto ? 200 : 503)
        .send({ status: pronto ? 'ok' : 'degradado', dependencias });
    },
  );

  await app.register(videosRoutes, { prefix: '/videos', casos: opcoes.casos });
  return app;
}
