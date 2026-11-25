import { randomUUID } from 'node:crypto';
import { TIPOS } from '../../src/domain/mensageria/contratos';

const base = (videoId: string) => ({
  id: randomUUID(),
  versao: 1 as const,
  videoId,
  origem: 'fiapx-video-processor',
  ocorridaEm: '2026-12-01T12:01:00.000Z',
});

export const iniciado = (videoId: string) => ({
  ...base(videoId),
  tipo: TIPOS.PROCESSAMENTO_INICIADO,
  dados: {},
});

export const processado = (
  videoId: string,
  chaveZip = `zips/${videoId}.zip`,
  totalFrames = 42,
) => ({
  ...base(videoId),
  tipo: TIPOS.PROCESSADO,
  dados: { chaveZip, totalFrames },
});

export const falhou = (videoId: string, motivo = 'arquivo corrompido') => ({
  ...base(videoId),
  tipo: TIPOS.FALHOU,
  dados: { motivo },
});
