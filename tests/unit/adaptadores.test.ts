import { describe, expect, it, vi } from 'vitest';
import { RedisCache } from '../../src/infrastructure/cache/redis-cache';
import {
  EmailNotificador,
  escaparHtml,
  notificadorDesligado,
} from '../../src/infrastructure/notificacao/email-notificador';
import { cacheDesligado } from '../../src/domain/portas/cache';
import { carregarEnv, lerTrustProxy } from '../../src/config/env';
import { LoggerEspiao } from '../support/fakes';

describe('RedisCache', () => {
  it('serializa, lê e remove', async () => {
    const armazenado = new Map<string, string>();
    const redis = {
      get: vi.fn(async (k: string) => armazenado.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => void armazenado.set(k, v)),
      del: vi.fn(async (k: string) => Number(armazenado.delete(k))),
    };
    const cache = new RedisCache(redis as never, new LoggerEspiao());

    await cache.definir('k', [{ a: 1 }], 30);
    expect(redis.set).toHaveBeenCalledWith('k', '[{"a":1}]', 'EX', 30);
    expect(await cache.obter('k')).toEqual([{ a: 1 }]);
    await cache.remover('k');
    expect(await cache.obter('k')).toBeNull();
  });

  it('Redis fora do ar não derruba a requisição', async () => {
    const quebrado = () => Promise.reject(new Error('ECONNREFUSED'));
    const logger = new LoggerEspiao();
    const cache = new RedisCache({ get: quebrado, set: quebrado, del: quebrado } as never, logger);

    expect(await cache.obter('k')).toBeNull();
    await expect(cache.definir('k', 1, 1)).resolves.toBeUndefined();
    await expect(cache.remover('k')).resolves.toBeUndefined();
    expect(logger.eventos('warn')).toEqual([
      'falha_integracao',
      'falha_integracao',
      'falha_integracao',
    ]);
  });

  it('cache desligado nunca guarda nada', async () => {
    await cacheDesligado.definir('k', 1, 1);
    await cacheDesligado.remover('k');
    expect(await cacheDesligado.obter('k')).toBeNull();
  });
});

describe('EmailNotificador', () => {
  it('escapa o nome do arquivo no HTML', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await new EmailNotificador({ sendMail }, 'FIAP X <x@y>').avisarFalha({
      destinatario: 'ana@fiapx.dev',
      nomeArquivo: '<img onerror=alert(1)>.mp4',
      motivo: 'codec "raro"',
      videoId: 'v1',
    });
    const email = sendMail.mock.calls[0]![0];
    expect(email.to).toBe('ana@fiapx.dev');
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img onerror=alert(1)&gt;.mp4');
    expect(email.html).toContain('codec &quot;raro&quot;');
  });

  it('escaparHtml cobre os cinco caracteres especiais', () => {
    expect(escaparHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#x27;');
  });

  it('notificador desligado não faz nada', async () => {
    await expect(
      notificadorDesligado.avisarFalha({
        destinatario: 'a',
        nomeArquivo: 'b',
        motivo: 'c',
        videoId: 'd',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('carregarEnv', () => {
  const minimo = {
    DATABASE_URL: 'postgresql://x',
    JWT_SECRET: 'a'.repeat(32),
    S3_BUCKET: 'videos',
  };

  it('aplica os padrões', () => {
    const env = carregarEnv(minimo);
    expect(env).toMatchObject({
      PORT: 3000,
      S3_FORCE_PATH_STYLE: false,
      VIDEO_TAMANHO_MAXIMO_MB: 500,
    });
  });

  it('Swagger ligado fora de produção e desligado em produção, salvo pedido explícito', () => {
    expect(carregarEnv(minimo).SWAGGER_ENABLED).toBe(true);
    expect(carregarEnv({ ...minimo, NODE_ENV: 'production' }).SWAGGER_ENABLED).toBe(false);
    expect(
      carregarEnv({ ...minimo, NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED,
    ).toBe(true);
  });

  it.each([
    ['', false],
    ['false', false],
    ['true', true],
    ['1', 1],
    ['10.0.0.0/8, 172.16.0.0/12', ['10.0.0.0/8', '172.16.0.0/12']],
  ])('TRUST_PROXY=%j vira %j', (valor, esperado) => {
    expect(lerTrustProxy(valor)).toEqual(esperado);
  });

  it('falha listando só os nomes das variáveis, sem os valores', () => {
    expect(() => carregarEnv({ ...minimo, JWT_SECRET: 'curto' })).toThrow(
      'Variáveis de ambiente inválidas: JWT_SECRET',
    );
  });
});
