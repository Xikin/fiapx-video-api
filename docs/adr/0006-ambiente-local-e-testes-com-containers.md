# ADR-0006: Docker Compose com LocalStack e testes com Testcontainers

**Status:** Aceita

## Contexto

O sistema depende de PostgreSQL, RabbitMQ, Redis, S3 e SMTP. Testes com tudo isso simulado por
mocks não pegam os erros que importam aqui (transação do outbox, assinatura da URL, DLQ). A demo
também precisa rodar sem a AWS, porque as credenciais do AWS Academy expiram a cada 4 horas.

## Decisão

- **Docker Compose** sobe o ambiente inteiro: PostgreSQL, RabbitMQ, Redis, **LocalStack** (S3) e
  **Mailpit** (caixa de e-mail em `http://localhost:8025`).
- **LocalStack** no lugar do MinIO: a imagem pública do MinIO deixou de ser publicada, e o
  LocalStack também emula a AWS que usaremos em produção. A validação de assinatura fica ligada
  (`S3_SKIP_SIGNATURE_VALIDATION=0`) para o S3 local recusar o que a AWS recusaria.
- **Testcontainers** nos testes de integração: cada suíte sobe PostgreSQL, RabbitMQ ou LocalStack
  reais, nas mesmas versões do Compose, e roda contra eles. No GitHub Actions o Docker já existe no
  runner.

## Consequências

- `docker compose up` sobe a demo inteira; a apresentação não depende do Learner Lab.
- A suíte completa leva cerca de 30 segundos a mais por causa dos containers.
- Os testes unitários continuam rodando sem Docker (`npm run test:unit`).
