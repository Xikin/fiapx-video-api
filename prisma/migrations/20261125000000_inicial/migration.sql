-- CreateEnum
CREATE TYPE "StatusVideo" AS ENUM ('AGUARDANDO_ENVIO', 'NA_FILA', 'PROCESSANDO', 'CONCLUIDO', 'FALHOU');

-- CreateTable
CREATE TABLE "videos" (
    "id" UUID NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "email_usuario" TEXT NOT NULL,
    "nome_arquivo" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "tamanho_bytes" BIGINT NOT NULL,
    "chave_video" TEXT NOT NULL,
    "chave_zip" TEXT,
    "total_frames" INTEGER,
    "status" "StatusVideo" NOT NULL,
    "motivo_falha" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publicado_em" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mensagens_processadas" (
    "id" UUID NOT NULL,
    "consumidor" TEXT NOT NULL,
    "processada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mensagens_processadas_pkey" PRIMARY KEY ("id","consumidor")
);

-- CreateIndex
CREATE INDEX "videos_usuario_id_criado_em_idx" ON "videos"("usuario_id", "criado_em" DESC);

-- CreateIndex
CREATE INDEX "outbox_publicado_em_criado_em_idx" ON "outbox"("publicado_em", "criado_em");

