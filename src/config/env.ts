import 'dotenv/config';
import { z } from 'zod';

const booleano = (padrao: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(padrao)
    .transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ALLOWED_ORIGINS: z.string().default(''),
  SWAGGER_ENABLED: booleano('true'),

  DATABASE_URL: z.string().min(1),

  /** Segredo compartilhado com o fiapx-auth-lambda, que emite o token (ADR 0005). */
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('fiapx-auth'),

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

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('FIAP X <nao-responda@fiapx.local>'),
});

export type Env = z.infer<typeof envSchema>;

export function carregarEnv(fonte: NodeJS.ProcessEnv = process.env): Env {
  const resultado = envSchema.safeParse(fonte);
  if (!resultado.success) {
    const campos = [...new Set(resultado.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Variáveis de ambiente inválidas: ${campos}`);
  }
  return resultado.data;
}
