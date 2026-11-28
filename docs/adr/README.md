# ADRs — Architecture Decision Records

Decisões de arquitetura do FIAP X. Formato: Contexto → Decisão → Consequências. As ADRs que valem
para todos os repositórios ficam aqui; os outros repositórios apontam para cá.

| ADR                                                    | Decisão                                                         | Status |
| ------------------------------------------------------ | --------------------------------------------------------------- | ------ |
| [0001](0001-microsservicos-e-clean-architecture.md)    | Dois microsserviços e uma Lambda, cada um em Clean Architecture | Aceita |
| [0002](0002-upload-direto-no-s3.md)                    | Upload e download direto no S3 por URL assinada                 | Aceita |
| [0003](0003-rabbitmq-outbox-idempotencia-dlq.md)       | RabbitMQ com outbox, consumo idempotente, retentativa e DLQ     | Aceita |
| [0004](0004-escala-do-worker-pela-fila.md)             | Worker escalado pelo tamanho da fila (KEDA)                     | Aceita |
| [0005](0005-autenticacao-jwt.md)                       | JWT emitido pela Lambda, validado no API Gateway e na API       | Aceita |
| [0006](0006-ambiente-local-e-testes-com-containers.md) | Docker Compose com LocalStack e testes com Testcontainers       | Aceita |
| [0007](0007-qualidade-e-seguranca-na-esteira.md)       | Qualidade e segurança como gates do CI                          | Aceita |
