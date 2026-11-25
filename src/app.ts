import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
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
  jwt: { segredo: string; emissor: string };
  /** Verifica as dependências para o readiness probe do Kubernetes. */
  prontidao?: () => Promise<Record<string, EstadoDependencia>>;
  log?: { nivel: string } | false;
  swagger?: boolean;
  origensPermitidas?: string[];
  limitePorMinuto?: number;
}

export async function buildApp(opcoes: OpcoesApp): Promise<FastifyInstance> {
  const app = Fastify({
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
      const id = req.headers['x-request-id'];
      return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : randomUUID();
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (req, rep, payload) => {
    rep.header('x-request-id', req.id);
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
