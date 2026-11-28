import type { VideoRepository } from '../../domain/portas/video.repository';
import type { Armazenamento, UrlAssinada } from '../../domain/portas/armazenamento';
import {
  STATUS_VIDEO,
  chaveZipPertenceAoVideo,
  sanitizarNomeArquivo,
} from '../../domain/videos/video';
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

    // Defesa em profundidade: o consumidor já recusa chaves fora do vídeo, mas uma
    // linha gravada antes dessa regra (ou por outro caminho) não pode virar URL
    // assinada para o objeto de outra pessoa.
    if (!chaveZipPertenceAoVideo(video.id, video.chaveZip))
      throw new ConflictError('O zip deste vídeo está indisponível; envie o vídeo de novo');

    const nome = sanitizarNomeArquivo(video.paraDados().nomeArquivo).replace(/\.[^.]+$/, '');
    return this.armazenamento.urlDeDownload(video.chaveZip, `${nome}-frames.zip`);
  }
}
