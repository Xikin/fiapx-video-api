import { ConflictError } from '../../shared/errors';

export const STATUS_VIDEO = {
  AGUARDANDO_ENVIO: 'AGUARDANDO_ENVIO',
  NA_FILA: 'NA_FILA',
  PROCESSANDO: 'PROCESSANDO',
  CONCLUIDO: 'CONCLUIDO',
  FALHOU: 'FALHOU',
} as const;

export type StatusVideo = (typeof STATUS_VIDEO)[keyof typeof STATUS_VIDEO];

const FINAIS: readonly StatusVideo[] = [STATUS_VIDEO.CONCLUIDO, STATUS_VIDEO.FALHOU];

export interface DadosVideo {
  id: string;
  usuarioId: string;
  emailUsuario: string;
  nomeArquivo: string;
  contentType: string;
  tamanhoBytes: number;
  chaveVideo: string;
  chaveZip: string | null;
  totalFrames: number | null;
  status: StatusVideo;
  motivoFalha: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
}

export interface NovoVideo {
  id: string;
  usuarioId: string;
  emailUsuario: string;
  nomeArquivo: string;
  contentType: string;
  tamanhoBytes: number;
  agora: Date;
}

/**
 * Ciclo de vida de um vídeo:
 *
 *   AGUARDANDO_ENVIO → NA_FILA → PROCESSANDO → CONCLUIDO
 *                          ↘           ↘
 *                           FALHOU ←────┘
 *
 * Os métodos que reagem a eventos do worker devolvem `false` quando o evento chega
 * atrasado (por exemplo, "processamento iniciado" depois de "processado"), para que
 * uma entrega fora de ordem não desfaça um estado final.
 */
export class Video {
  private constructor(private dados: DadosVideo) {}

  static criar(novo: NovoVideo): Video {
    return new Video({
      id: novo.id,
      usuarioId: novo.usuarioId,
      emailUsuario: novo.emailUsuario,
      nomeArquivo: novo.nomeArquivo,
      contentType: novo.contentType,
      tamanhoBytes: novo.tamanhoBytes,
      chaveVideo: chaveDoVideo(novo.usuarioId, novo.id, novo.nomeArquivo),
      chaveZip: null,
      totalFrames: null,
      status: STATUS_VIDEO.AGUARDANDO_ENVIO,
      motivoFalha: null,
      criadoEm: novo.agora,
      atualizadoEm: novo.agora,
    });
  }

  static restaurar(dados: DadosVideo): Video {
    return new Video({ ...dados });
  }

  get id() {
    return this.dados.id;
  }
  get usuarioId() {
    return this.dados.usuarioId;
  }
  get status() {
    return this.dados.status;
  }
  get chaveVideo() {
    return this.dados.chaveVideo;
  }
  get chaveZip() {
    return this.dados.chaveZip;
  }

  pertenceA(usuarioId: string): boolean {
    return this.dados.usuarioId === usuarioId;
  }

  get finalizado(): boolean {
    return FINAIS.includes(this.dados.status);
  }

  confirmarEnvio(agora: Date): void {
    if (this.dados.status !== STATUS_VIDEO.AGUARDANDO_ENVIO)
      throw new ConflictError(
        `O envio deste vídeo já foi confirmado (status ${this.dados.status})`,
      );
    this.mudar(STATUS_VIDEO.NA_FILA, agora);
  }

  iniciarProcessamento(agora: Date): boolean {
    if (this.dados.status !== STATUS_VIDEO.NA_FILA) return false;
    this.mudar(STATUS_VIDEO.PROCESSANDO, agora);
    return true;
  }

  concluir(resultado: { chaveZip: string; totalFrames: number }, agora: Date): boolean {
    if (this.finalizado || this.dados.status === STATUS_VIDEO.AGUARDANDO_ENVIO) return false;
    this.dados.chaveZip = resultado.chaveZip;
    this.dados.totalFrames = resultado.totalFrames;
    this.mudar(STATUS_VIDEO.CONCLUIDO, agora);
    return true;
  }

  falhar(motivo: string, agora: Date): boolean {
    if (this.finalizado) return false;
    this.dados.motivoFalha = motivo.slice(0, 500);
    this.mudar(STATUS_VIDEO.FALHOU, agora);
    return true;
  }

  paraDados(): DadosVideo {
    return { ...this.dados };
  }

  private mudar(status: StatusVideo, agora: Date): void {
    this.dados.status = status;
    this.dados.atualizadoEm = agora;
  }
}

/** Mantém só caracteres seguros para chave de objeto e para o cabeçalho de download. */
export function sanitizarNomeArquivo(nome: string): string {
  const base = nome.split(/[\\/]/).pop() ?? '';
  const limpo = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return limpo || 'video';
}

export function chaveDoVideo(usuarioId: string, videoId: string, nomeArquivo: string): string {
  return `videos/${usuarioId}/${videoId}/${sanitizarNomeArquivo(nomeArquivo)}`;
}
