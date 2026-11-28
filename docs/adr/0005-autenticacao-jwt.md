# ADR-0005: JWT emitido pela Lambda, validado no API Gateway e na API

**Status:** Aceita

## Contexto

O sistema deve ser protegido por usuário e senha. Na Fase 3 a autenticação de clientes ficou numa
Lambda atrás do API Gateway, e esse padrão foi aprovado.

## Decisão

- O `fiapx-auth-lambda` faz cadastro e login (senha com bcrypt) e emite um JWT HS256 com `sub`
  (id do usuário), `email` e `iss = fiapx-auth`, com expiração curta.
- O API Gateway rejeita requisições sem token válido antes de chegarem ao cluster.
- A Video API valida o token de novo (`src/presentation/http/plugins/autenticacao.ts`), exigindo
  emissor, algoritmo e expiração. Isso protege a API quando chamada de dentro do cluster ou no
  Docker Compose.
  - `exp` é obrigatório (`requiredClaims`): sem ele o fast-jwt aceitaria o token para sempre.
  - Validade acima de `JWT_VALIDADE_MAXIMA_SEGUNDOS` (padrão 24 h) é recusada.
  - `sub` só aceita `[A-Za-z0-9._:-]` (vira pasta no S3) e `email` precisa ter formato de e-mail.
  - `aud` passa a ser exigido quando `JWT_AUDIENCE` estiver definido.
- Vídeo de outro usuário responde 404, não 403, para não revelar quais ids existem.

## Consequências

- A API e a Lambda compartilham o `JWT_SECRET`, distribuído pelos pipelines como segredo.
- Trocar para RS256 com JWKS publicado pela Lambda eliminaria o segredo compartilhado; fica como
  evolução.
- Para testar sem a Lambda, `npx tsx scripts/gerar-token.ts` gera um token local.
