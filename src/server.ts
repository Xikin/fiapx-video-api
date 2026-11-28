import { buildApp } from './app';
import { carregarEnv } from './config/env';
import { montarContainer } from './container';

async function iniciar() {
  const env = carregarEnv();
  const origens = env.ALLOWED_ORIGINS.split(',').filter(Boolean);

  // O logger nasce com o Fastify; o container recebe uma referência tardia a ele.
  const logger = { info: noop, warn: noop, error: noop } as {
    info: (o: object, m?: string) => void;
    warn: (o: object, m?: string) => void;
    error: (o: object, m?: string) => void;
  };
  const container = montarContainer(env, logger);
  const app = await buildApp({
    casos: container.casos,
    prontidao: container.prontidao,
    jwt: {
      segredo: env.JWT_SECRET,
      emissor: env.JWT_ISSUER,
      audiencia: env.JWT_AUDIENCE,
      validadeMaximaSegundos: env.JWT_VALIDADE_MAXIMA_SEGUNDOS,
    },
    log: { nivel: env.LOG_LEVEL },
    swagger: env.SWAGGER_ENABLED,
    origensPermitidas: origens,
    trustProxy: env.TRUST_PROXY,
    limitePorMinuto: env.RATE_LIMIT_POR_MINUTO,
    redisRateLimit: container.redis ?? undefined,
  });
  Object.assign(logger, {
    info: app.log.info.bind(app.log),
    warn: app.log.warn.bind(app.log),
    error: app.log.error.bind(app.log),
  });

  await container.iniciarMensageria();
  await app.listen({ port: env.PORT, host: env.HOST });

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    app.log.info({ evento: 'encerramento_iniciado', sinal }, 'encerrando');
    try {
      await app.close();
      await container.encerrar();
      process.exit(0);
    } catch (erro) {
      app.log.error({ evento: 'encerramento_falhou', err: erro }, 'falha ao encerrar');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
  process.on('SIGINT', () => void encerrar('SIGINT'));
}

function noop() {}

iniciar().catch((erro) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      service: 'fiapx-video-api',
      evento: 'falha_ao_iniciar',
      message: erro instanceof Error ? erro.message : String(erro),
    }),
  );
  process.exit(1);
});
