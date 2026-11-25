import type { VideoRepository } from '../../domain/portas/video.repository';
import type { Video } from '../../domain/videos/video';
import { NotFoundError } from '../../shared/errors';

/**
 * Vídeo de outro usuário responde como inexistente (404, não 403), para não
 * revelar quais ids existem.
 */
export async function buscarVideoDoUsuario(
  videos: VideoRepository,
  usuarioId: string,
  videoId: string,
): Promise<Video> {
  const video = await videos.buscarPorId(videoId);
  if (!video || !video.pertenceA(usuarioId)) throw new NotFoundError('Vídeo');
  return video;
}
