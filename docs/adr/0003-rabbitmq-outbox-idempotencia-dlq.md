# ADR-0003: RabbitMQ com outbox, consumo idempotente, retentativa e DLQ

**Status:** Aceita

## Contexto

Requisito do hackathon: em caso de pico, nenhuma requisição pode ser perdida. Os pontos onde um
pedido some sem esses cuidados são: a API grava o status e cai antes de publicar; o broker está fora
do ar na hora de publicar; o worker cai no meio do processamento; a mesma mensagem é entregue duas
vezes.

## Decisão

Mesmo padrão da Fase 4 (ADR 0015 do Tech Challenge), aplicado ao fluxo de vídeos:

| Risco                              | Proteção                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gravar o status e não publicar     | **Outbox transacional**: `video.enviado` é gravado na tabela `outbox` na mesma transação que muda o status. Um relay publica com `FOR UPDATE SKIP LOCKED`, seguro com várias réplicas.       |
| Broker fora do ar                  | A linha fica no outbox e o relay tenta de novo a cada ciclo.                                                                                                                                 |
| Mensagem sem fila de destino       | Publicação com `mandatory` e confirmação do broker: se nenhuma fila recebe, a publicação falha e fica no outbox.                                                                             |
| Worker cai no meio                 | `ack` só depois de tratar; a mensagem volta para a fila. Filas e mensagens são duráveis.                                                                                                     |
| Erro passageiro                    | Fila `.retry` com TTL devolve a mensagem para a fila principal, até `MENSAGERIA_MAX_TENTATIVAS`.                                                                                             |
| Erro permanente                    | Mensagem fora do contrato ou tentativas esgotadas vão para a fila `.dlq`, com alerta.                                                                                                        |
| Entrega duplicada                  | Tabela `mensagens_processadas`: a mesma mensagem muda o vídeo uma vez e gera um e-mail só.                                                                                                   |
| Eventos fora de ordem              | A entidade `Video` ignora eventos que chegam depois de um estado final.                                                                                                                      |
| Eventos do mesmo vídeo em paralelo | **Concorrência otimista**: o repositório só grava se o banco ainda estiver no status lido (`updateMany ... where status`). Quem perde relê e reaplica; a confirmação duplicada responde 409. |
| Canal cai durante o tratamento     | `ack`/`nack` com o canal fechado são registrados sem derrubar o processo; o broker reentrega e a idempotência absorve.                                                                       |

Exchange `fiapx.videos` (topic). Contratos em `src/domain/mensageria/contratos.ts`, validados com Zod
nos dois lados:

| Evento                         | Publicado por   | Consumido por                             |
| ------------------------------ | --------------- | ----------------------------------------- |
| `video.enviado`                | Video API       | Video Processor                           |
| `video.processamento-iniciado` | Video Processor | Video API                                 |
| `video.processado`             | Video Processor | Video API                                 |
| `video.falhou`                 | Video Processor | Video API (grava o motivo e envia e-mail) |

## Consequências

- Entrega "pelo menos uma vez" com efeito "exatamente uma vez" no status.
- As marcas em `mensagens_processadas` são apagadas depois de 7 dias pelo relay. Uma reentrega
  mais tardia continua inofensiva: o status final não muda e o e-mail só sai quando o status muda.
- O e-mail de falha é enviado depois de gravar o status; se o SMTP falhar, o erro é registrado e a
  mensagem não volta para a fila (o status já está certo e o usuário o vê na listagem).
- O teste `tests/integration/infra/postgres-outbox.test.ts` prova que duas réplicas do relay não
  publicam a mesma linha duas vezes; o teste de carga com k6 fecha a prova de ponta a ponta.
