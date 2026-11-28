import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';

/** Mesmas versões do docker-compose.yml, para o teste exercitar o que roda em produção. */
export const IMAGENS = {
  postgres: 'postgres:16-alpine',
  rabbitmq: 'rabbitmq:4.1-management-alpine',
  localstack: 'localstack/localstack:4.0',
};

export async function iniciarPostgres(): Promise<{
  container: StartedPostgreSqlContainer;
  url: string;
}> {
  const container = await new PostgreSqlContainer(IMAGENS.postgres).start();
  const url = container.getConnectionUri();
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  return { container, url };
}

export async function iniciarRabbitMQ(): Promise<{
  container: StartedRabbitMQContainer;
  url: string;
}> {
  const container = await new RabbitMQContainer(IMAGENS.rabbitmq).start();
  return { container, url: container.getAmqpUrl() };
}

export async function esperar<T>(
  condicao: () => Promise<T | undefined | null | false>,
  { tempoMs = 15_000, intervaloMs = 100 } = {},
): Promise<T> {
  const limite = Date.now() + tempoMs;
  while (Date.now() < limite) {
    const valor = await condicao();
    if (valor) return valor;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  throw new Error(`condição não satisfeita em ${tempoMs} ms`);
}
