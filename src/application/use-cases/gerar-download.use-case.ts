import type { VideoRepository } from '../../domain/portas/video.repository';
import type { Armazenamento, UrlAssinada } from '../../domain/portas/armazenamento';
import { STATUS_VIDEO, sanitizarNomeArquivo } from '../../domain/videos/video';
import { ConflictError } from '../../shared/errors';
import { buscarVideoDoUsuario } from './buscar-video-do-usuario';

export class GerarDownloadUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly armazenamento: Armazenamento,
  ) {}

  async execute(usuarioId: string, videoId: string): Promise<UrlAssinada> {
    const video = await buscarVideoDoUsuario(this.videos, usuarioId, videoId);
    if (video.status !== STATUS_VIDEO.CONCLUIDO || !video.chaveZip)
      throw new ConflictError(`O zip ainda não está pronto (status ${video.status})`);

    const nome = sanitizarNomeArquivo(video.paraDados().nomeArquivo).replace(/\.[^.]+$/, '');
    return this.armazenamento.urlDeDownload(video.chaveZip, `${nome}-frames.zip`);
  }
}
