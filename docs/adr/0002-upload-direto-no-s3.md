# ADR-0002: Upload e download direto no S3 por URL assinada

**Status:** Aceita

## Contexto

Vídeos têm centenas de megabytes. O API Gateway HTTP API limita o corpo da requisição a 10 MB e o
tempo a 30 segundos. Passar o arquivo pela API também ocuparia memória e banda dos pods que
deveriam só responder status.

## Decisão

O envio tem dois passos:

1. `POST /videos` registra o vídeo como `AGUARDANDO_ENVIO` e devolve uma URL `PUT` assinada.
2. O cliente envia o arquivo direto ao S3 e chama `POST /videos/{id}/confirmar-envio`. A API confere
   no S3 que o objeto existe e tem o tamanho declarado, e só então coloca o vídeo na fila.

O download também é uma URL `GET` assinada, gerada só para o dono e só com o zip pronto.

Regras de segurança da URL:

- Assina `content-type` e `content-length`: o cliente não troca o tipo nem o tamanho declarados
  (coberto por teste com o LocalStack validando a assinatura).
- Expira em 15 minutos (`URL_ASSINADA_TTL_SEGUNDOS`).
- A chave do objeto fica sob `videos/{usuarioId}/{videoId}/`, com o nome do arquivo sanitizado.
- O bucket é privado.

## Consequências

- A API nunca toca no conteúdo do vídeo e o tamanho máximo deixa de depender do API Gateway.
- O cliente faz três chamadas em vez de uma; o front e a coleção Postman encapsulam isso.
- Um envio abandonado deixa um registro `AGUARDANDO_ENVIO`; uma regra de ciclo de vida do bucket e
  uma limpeza periódica resolvem isso mais tarde.
