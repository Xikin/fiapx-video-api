import type { VideoRepository } from '../../domain/portas/video.repository';
import { chaveListaDoUsuario, type Cache } from '../../domain/portas/cache';
import { paraDto, type VideoDto } from '../video.dto';

export const TTL_LISTA_SEGUNDOS = 30;

/** Lista com cache curto: é a rota mais chamada, porque o cliente consulta o status em ciclo. */
export class ListarVideosUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly cache: Cache,
  ) {}

  async execute(usuarioId: string): Promise<VideoDto[]> {
    const chave = chaveListaDoUsuario(usuarioId);
    const emCache = await this.cache.obter<VideoDto[]>(chave);
    if (emCache) return emCache;

    const lista = (await this.videos.listarPorUsuario(usuarioId)).map(paraDto);
    await this.cache.definir(chave, lista, TTL_LISTA_SEGUNDOS);
    return lista;
  }
}
