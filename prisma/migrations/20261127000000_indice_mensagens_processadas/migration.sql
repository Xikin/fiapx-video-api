-- Índice para a limpeza periódica das marcas de consumo antigas (OutboxRelay.limparConsumidas).
-- CreateIndex
CREATE INDEX "mensagens_processadas_processada_em_idx" ON "mensagens_processadas"("processada_em");
