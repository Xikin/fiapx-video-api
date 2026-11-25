# ADR-0004: Worker escalado pelo tamanho da fila (KEDA)

**Status:** Aceita

## Contexto

O hackathon pede processar vários vídeos ao mesmo tempo. O uso de CPU do worker é um mau sinal
para escalar: um pod parado esperando mensagem usa pouca CPU mesmo com a fila cheia, e o HPA por CPU
reage tarde.

## Decisão

- O worker consome com `prefetch=1`: cada pod processa um vídeo por vez, com memória previsível.
- O número de pods acompanha a fila `video-processor.videos` com um `ScaledObject` do KEDA
  (gatilho `rabbitmq`, `queueLength` por pod), de 1 até um máximo configurado.
- A API, que é leve e responde HTTP, continua com HPA por CPU e memória, como na Fase 4.

## Consequências

- Em pico, a fila absorve a diferença e os pods sobem até o limite; nada é recusado.
- Exige instalar o KEDA no cluster (`fiapx-infra-k8s`).
- O limite de pods precisa caber nos nós do AWS Academy; o restante espera na fila.
