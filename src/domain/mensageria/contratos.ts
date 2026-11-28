import { z } from 'zod';
import { chaveZipPertenceAoVideo } from '../videos/video';

/**
 * Contratos das mensagens trocadas com o fiapx-video-processor pelo exchange
 * `fiapx.videos` (topic). O worker usa os mesmos schemas; qualquer mudança aqui
 * precisa de uma nova `versao`.
 */
export const EXCHANGE_VIDEOS = 'fiapx.videos';
export const ORIGEM_API = 'fiapx-video-api';

export const TIPOS = {
  ENVIADO: 'video.enviado',
  PROCESSAMENTO_INICIADO: 'video.processamento-iniciado',
  PROCESSADO: 'video.processado',
  FALHOU: 'video.falhou',
} as const;

const envelope = <T extends string, D extends z.ZodTypeAny>(tipo: T, dados: D) =>
  z.object({
    id: z.string().uuid(),
    tipo: z.literal(tipo),
    versao: z.literal(1),
    videoId: z.string().uuid(),
    origem: z.string().min(1),
    ocorridaEm: z.string().datetime(),
    dados,
  });

export const videoEnviadoSchema = envelope(
  TIPOS.ENVIADO,
  z.object({
    usuarioId: z.string().min(1),
    chaveVideo: z.string().min(1),
    nomeArquivo: z.string().min(1),
    contentType: z.string().min(1),
    tamanhoBytes: z.number().int().positive(),
  }),
);

export const processamentoIniciadoSchema = envelope(
  TIPOS.PROCESSAMENTO_INICIADO,
  z.object({}).passthrough(),
);

export const videoProcessadoSchema = envelope(
  TIPOS.PROCESSADO,
  z.object({
    chaveZip: z.string().min(1),
    totalFrames: z.number().int().nonnegative(),
  }),
);

export const videoFalhouSchema = envelope(TIPOS.FALHOU, z.object({ motivo: z.string().min(1) }));

export const resultadoDoWorkerSchema = z.discriminatedUnion('tipo', [
  processamentoIniciadoSchema,
  videoProcessadoSchema,
  videoFalhouSchema,
]);

export type VideoEnviado = z.infer<typeof videoEnviadoSchema>;
export type ResultadoDoWorker = z.infer<typeof resultadoDoWorkerSchema>;
export type Mensagem = VideoEnviado | ResultadoDoWorker;

/** Mensagem que não deve ser tentada de novo: vai direto para a fila de mortas. */
export class MensagemInvalidaError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'MensagemInvalidaError';
  }
}

export function lerResultadoDoWorker(bruto: unknown): ResultadoDoWorker {
  const resultado = resultadoDoWorkerSchema.safeParse(bruto);
  if (!resultado.success)
    throw new MensagemInvalidaError(
      `mensagem fora do contrato: ${resultado.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );

  // Regra que cruza dois campos do envelope (videoId x dados.chaveZip): feita aqui,
  // depois do parse, para não depender de refinamentos dentro do discriminatedUnion.
  // Uma chave fora do vídeo é definitiva: vai para a DLQ, sem retentativa.
  const mensagem = resultado.data;
  if (
    mensagem.tipo === TIPOS.PROCESSADO &&
    !chaveZipPertenceAoVideo(mensagem.videoId, mensagem.dados.chaveZip)
  )
    throw new MensagemInvalidaError(
      'mensagem fora do contrato: dados.chaveZip não pertence ao vídeo informado',
    );
  return mensagem;
}
