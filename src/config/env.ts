import 'dotenv/config';
import { z } from 'zod';

const booleano = (padrao: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(padrao)
    .transform((v) => v === 'true');

/** Booleano sem padrão fixo: `undefined` quando ausente, para o padrão depender de outra variável. */
const booleanoOpcional = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

/**
 * Converte `TRUST_PROXY` para o formato do Fastify:
 *   - `false` (padrão) ou `true`
 *   - um número: quantos saltos de proxy confiar (ex.: `1` atrás de um único LB)
 *   - lista separada por vírgula de IPs/CIDRs (ex.: `10.0.0.0/8,172.16.0.0/12`)
 */
export function lerTrustProxy(valor: string): boolean | number | string[] {
  const limpo = valor.trim();
  if (limpo === '' || limpo === 'false') return false;
  if (limpo === 'true') return true;
  if (/^\d+$/.test(limpo)) return Number(limpo);
  return limpo
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    ALLOWED_ORIGINS: z.string().default(''),
    /** Padrão: ligado fora de produção e desligado em produção (ver transform abaixo). */
    SWAGGER_ENABLED: booleanoOpcional,
    /** Proxies confiáveis para `X-Forwarded-For`; ver `lerTrustProxy`. */
    TRUST_PROXY: z.string().default('false').transform(lerTrustProxy),
    RATE_LIMIT_POR_MINUTO: z.coerce.number().int().positive().default(120),

    DATABASE_URL: z.string().min(1),

    /** Segredo compartilhado com o fiapx-auth-lambda, que emite o token (ADR 0005). */
    JWT_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().default('fiapx-auth'),
    /** Quando definido, o token precisa trazer `aud` com este valor. */
    JWT_AUDIENCE: z.string().min(1).optional(),
    /** Teto de validade aceito para um token (exp - agora), em segundos. Padrão: 24 h. */
    JWT_VALIDADE_MAXIMA_SEGUNDOS: z.coerce.number().int().positive().default(86_400),

    RABBITMQ_URL: z.string().url().optional(),
    MENSAGERIA_MAX_TENTATIVAS: z.coerce.number().int().positive().default(5),
    MENSAGERIA_ATRASO_RETENTATIVA_MS: z.coerce.number().int().positive().default(5000),
    OUTBOX_INTERVALO_MS: z.coerce.number().int().positive().default(500),

    REDIS_URL: z.string().url().optional(),

    AWS_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    /** Endpoint interno (LocalStack no Docker Compose). Vazio na AWS. */
    S3_ENDPOINT: z.string().url().optional(),
    /** Endpoint que o navegador enxerga, usado nas URLs assinadas. Vazio na AWS. */
    S3_ENDPOINT_PUBLICO: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: booleano('false'),
    URL_ASSINADA_TTL_SEGUNDOS: z.coerce.number().int().positive().max(3600).default(900),
    VIDEO_TAMANHO_MAXIMO_MB: z.coerce.number().int().positive().default(500),
    /**
     * Quantas URLs de envio um usuário pode ter abertas ao mesmo tempo (vídeos em
     * AGUARDANDO_ENVIO criados dentro do TTL da URL). Evita abuso de custo no S3.
     */
    VIDEO_ENVIOS_PENDENTES_MAX: z.coerce.number().int().positive().default(10),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().default('FIAP X <nao-responda@fiapx.local>'),
  })
  // Padrões que dependem de outras variáveis: o Swagger expõe toda a superfície
  // da API, então só fica ligado em produção quando alguém pede explicitamente.
  .transform((env) => ({
    ...env,
    SWAGGER_ENABLED: env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production',
  }));

export type Env = z.infer<typeof envSchema>;

export function carregarEnv(fonte: NodeJS.ProcessEnv = process.env): Env {
  const resultado = envSchema.safeParse(fonte);
  if (!resultado.success) {
    const campos = [...new Set(resultado.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Variáveis de ambiente inválidas: ${campos}`);
  }
  return resultado.data;
}
