# ADR-0001: Dois microsserviços e uma Lambda, cada um em Clean Architecture

**Status:** Aceita

## Contexto

O projeto base é um único servidor que recebe o vídeo, roda o FFmpeg dentro da requisição HTTP e
guarda tudo no disco local. Um vídeo longo prende a conexão, vários ao mesmo tempo derrubam o
servidor, e não há como escalar só a parte cara (o FFmpeg). O hackathon pede microsserviços,
escala e que nenhuma requisição se perca em pico.

## Decisão

| Componente          | Repositório             | Responsabilidade                                                        | Dados                             |
| ------------------- | ----------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| **Video API**       | `fiapx-video-api`       | Registrar envio, listar status, gerar download, avisar falha por e-mail | PostgreSQL + Redis                |
| **Video Processor** | `fiapx-video-processor` | Consumir a fila, extrair frames com FFmpeg, gerar o zip                 | Nenhum banco; lê e grava no S3    |
| **Auth**            | `fiapx-auth-lambda`     | Cadastro, login e emissão do JWT                                        | Próprio (decidido no repositório) |

O corte separa o que é **rápido e chamado o tempo todo** (a API) do que é **lento e caro**
(o processamento). Os dois escalam e falham de forma independente.

Cada serviço segue as camadas da Fase 4: `domain` (entidades e portas), `application` (casos de
uso), `infrastructure` (adaptadores) e `presentation` (HTTP). O domínio não importa Prisma,
Fastify, AWS SDK nem amqplib; só a raiz de composição (`src/container.ts`) conhece as
implementações concretas.

## Consequências

- O status do vídeo tem um dono só (a API); o worker comunica o andamento por eventos (ADR 0003).
- Os casos de uso são testados com dublês em memória, sem infraestrutura (`tests/unit`).
- Há mais repositórios e pipelines para manter do que num monólito.
