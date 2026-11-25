import { Video } from '../../domain/videos/video';
import type { VideoRepository } from '../../domain/portas/video.repository';
import type { Armazenamento, UrlAssinada } from '../../domain/portas/armazenamento';
import { chaveListaDoUsuario, type Cache } from '../../domain/portas/cache';
import type { GeradorDeId, Relogio } from '../../domain/portas/relogio';
import { BusinessError } from '../../shared/errors';
import { paraDto, type UsuarioAutenticado, type VideoDto } from '../video.dto';

export const TIPOS_DE_VIDEO_ACEITOS = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
] as const;

export interface SolicitarEnvioEntrada {
  usuario: UsuarioAutenticado;
  nomeArquivo: string;
  contentType: string;
  tamanhoBytes: number;
}

export interface SolicitarEnvioSaida {
  video: VideoDto;
  envio: UrlAssinada;
}

/**
 * Primeiro passo do envio: registra o vídeo e devolve uma URL assinada para o
 * cliente mandar o arquivo direto ao S3 (ADR 0002). Nada vai para a fila ainda.
 */
export class SolicitarEnvioUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly armazenamento: Armazenamento,
    private readonly cache: Cache,
    private readonly ids: GeradorDeId,
    private readonly relogio: Relogio,
    private readonly tamanhoMaximoBytes: number,
  ) {}

  async execute(entrada: SolicitarEnvioEntrada): Promise<SolicitarEnvioSaida> {
    if (!(TIPOS_DE_VIDEO_ACEITOS as readonly string[]).includes(entrada.contentType))
      throw new BusinessError(
        `Tipo de arquivo não aceito: ${entrada.contentType}. Envie ${TIPOS_DE_VIDEO_ACEITOS.join(', ')}`,
      );
    if (entrada.tamanhoBytes > this.tamanhoMaximoBytes)
      throw new BusinessError(
        `O vídeo passa do limite de ${Math.floor(this.tamanhoMaximoBytes / 1024 / 1024)} MB`,
      );

    const video = Video.criar({
      id: this.ids.novo(),
      usuarioId: entrada.usuario.id,
      emailUsuario: entrada.usuario.email,
      nomeArquivo: entrada.nomeArquivo,
      contentType: entrada.contentType,
      tamanhoBytes: entrada.tamanhoBytes,
      agora: this.relogio.agora(),
    });

    await this.videos.criar(video);
    await this.cache.remover(chaveListaDoUsuario(entrada.usuario.id));
    const envio = await this.armazenamento.urlDeEnvio(
      video.chaveVideo,
      entrada.contentType,
      entrada.tamanhoBytes,
    );
    return { video: paraDto(video), envio };
  }
}
