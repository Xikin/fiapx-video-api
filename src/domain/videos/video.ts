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
  /**
   * Status que o banco tinha quando este objeto foi lido (ou gravado pela última
   * vez). O repositório só grava se o banco ainda estiver nele: é o controle de
   * concorrência otimista que impede um consumidor de sobrescrever o que outro
   * gravou em paralelo.
   *
   * O status serve de versão porque a máquina de estados só anda para frente:
   * um vídeo nunca volta a um status anterior, então não existe o problema ABA
   * (sair de X e voltar a X sem o leitor perceber).
   */
  private statusNoBanco: StatusVideo;

  private constructor(private dados: DadosVideo) {
    this.statusNoBanco = dados.status;
  }

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

  /** Status esperado no banco na próxima gravação; ver `statusNoBanco`. */
  get statusPersistido(): StatusVideo {
    return this.statusNoBanco;
  }

  /** Chamado pelo repositório depois que a gravação foi confirmada (commit). */
  marcarPersistido(): void {
    this.statusNoBanco = this.dados.status;
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

/** Pasta do bucket onde o fiapx-video-processor grava os zips de frames. */
export const PREFIXO_ZIPS = 'zips/';

/** Limite de tamanho de chave do próprio S3 (1024 bytes); acima disso não é chave válida. */
const TAMANHO_MAXIMO_CHAVE = 1024;

/** Cada parte do caminho só aceita caracteres seguros: sem espaço, `\` ou controle. */
const SEGMENTO_SEGURO = /^[A-Za-z0-9._-]+$/;

/**
 * Confere se a chave do zip que o worker informou aponta para um objeto **deste**
 * vídeo. Sem isso, quem conseguir publicar no exchange poderia mandar a chave de
 * um arquivo de outro usuário (por exemplo `videos/<outro>/...`) e a API assinaria
 * uma URL de download para ela (Broken Access Control).
 *
 * Formatos aceitos, sempre sob `zips/`:
 *   - `zips/<videoId>.zip`
 *   - `zips/<...>/<videoId>/<arquivo>.zip`
 *
 * Recusa segmentos vazios (`//`), `.` e `..`, caracteres fora da lista segura,
 * extensão diferente de `.zip` e chaves maiores que o limite do S3.
 */
export function chaveZipPertenceAoVideo(videoId: string, chave: string): boolean {
  // Um id vazio faria `zips/.zip` casar; o id real é sempre um UUID.
  if (!videoId || chave.length > TAMANHO_MAXIMO_CHAVE || !chave.startsWith(PREFIXO_ZIPS))
    return false;

  const segmentos = chave.slice(PREFIXO_ZIPS.length).split('/');
  const invalido = (s: string) => !SEGMENTO_SEGURO.test(s) || s === '.' || s === '..';
  if (segmentos.some(invalido)) return false;

  const arquivo = segmentos.at(-1) ?? '';
  if (!arquivo.toLowerCase().endsWith('.zip')) return false;

  // O id do vídeo precisa ser o nome do arquivo ou uma das pastas acima dele.
  return arquivo === `${videoId}.zip` || segmentos.slice(0, -1).includes(videoId);
}
