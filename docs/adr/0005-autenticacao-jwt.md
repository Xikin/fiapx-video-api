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
- Vídeo de outro usuário responde 404, não 403, para não revelar quais ids existem.

## Consequências

- A API e a Lambda compartilham o `JWT_SECRET`, distribuído pelos pipelines como segredo.
- Trocar para RS256 com JWKS publicado pela Lambda eliminaria o segredo compartilhado; fica como
  evolução.
- Para testar sem a Lambda, `npx tsx scripts/gerar-token.ts` gera um token local.
