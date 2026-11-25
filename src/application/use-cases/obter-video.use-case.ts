import type { VideoRepository } from '../../domain/portas/video.repository';
import { paraDto, type VideoDto } from '../video.dto';
import { buscarVideoDoUsuario } from './buscar-video-do-usuario';

export class ObterVideoUseCase {
  constructor(private readonly videos: VideoRepository) {}

  async execute(usuarioId: string, videoId: string): Promise<VideoDto> {
    return paraDto(await buscarVideoDoUsuario(this.videos, usuarioId, videoId));
  }
}
