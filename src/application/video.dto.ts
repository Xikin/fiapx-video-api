import { STATUS_VIDEO, type StatusVideo, type Video } from '../domain/videos/video';

export interface VideoDto {
  id: string;
  nomeArquivo: string;
  status: StatusVideo;
  tamanhoBytes: number;
  totalFrames: number | null;
  motivoFalha: string | null;
  downloadDisponivel: boolean;
  criadoEm: string;
  atualizadoEm: string;
}

export function paraDto(video: Video): VideoDto {
  const d = video.paraDados();
  return {
    id: d.id,
    nomeArquivo: d.nomeArquivo,
    status: d.status,
    tamanhoBytes: d.tamanhoBytes,
    totalFrames: d.totalFrames,
    motivoFalha: d.motivoFalha,
    downloadDisponivel: d.status === STATUS_VIDEO.CONCLUIDO,
    criadoEm: d.criadoEm.toISOString(),
    atualizadoEm: d.atualizadoEm.toISOString(),
  };
}

export interface UsuarioAutenticado {
  id: string;
  email: string;
}
