import type { VideoRepository } from '../../domain/portas/video.repository';
import type { Armazenamento } from '../../domain/portas/armazenamento';
import { chaveListaDoUsuario, type Cache } from '../../domain/portas/cache';
import type { GeradorDeId, Relogio } from '../../domain/portas/relogio';
import { ORIGEM_API, TIPOS, type VideoEnviado } from '../../domain/mensageria/contratos';
import { BusinessError, ConcorrenciaError, ConflictError } from '../../shared/errors';
import { paraDto, type VideoDto } from '../video.dto';
import { buscarVideoDoUsuario } from './buscar-video-do-usuario';

/**
 * Segundo passo do envio: confere que o arquivo chegou ao S3 com o tamanho
 * declarado e coloca o vídeo na fila. O evento vai para o outbox na mesma
 * transação, então um pico ou uma queda do RabbitMQ não perde o pedido (ADR 0003).
 */
export class ConfirmarEnvioUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly armazenamento: Armazenamento,
    private readonly cache: Cache,
    private readonly ids: GeradorDeId,
    private readonly relogio: Relogio,
  ) {}

  async execute(usuarioId: string, videoId: string): Promise<VideoDto> {
    const video = await buscarVideoDoUsuario(this.videos, usuarioId, videoId);
    const dados = video.paraDados();

    const tamanho = await this.armazenamento.tamanho(dados.chaveVideo);
    if (tamanho === null)
      throw new BusinessError('O arquivo ainda não chegou ao armazenamento; envie-o antes');
    if (tamanho !== dados.tamanhoBytes)
      throw new BusinessError(
        `O arquivo enviado tem ${tamanho} bytes, mas foram declarados ${dados.tamanhoBytes}`,
      );

    const agora = this.relogio.agora();
    video.confirmarEnvio(agora);

    const evento: VideoEnviado = {
      id: this.ids.novo(),
      tipo: TIPOS.ENVIADO,
      versao: 1,
      videoId: dados.id,
      origem: ORIGEM_API,
      ocorridaEm: agora.toISOString(),
      dados: {
        usuarioId: dados.usuarioId,
        chaveVideo: dados.chaveVideo,
        nomeArquivo: dados.nomeArquivo,
        contentType: dados.contentType,
        tamanhoBytes: dados.tamanhoBytes,
      },
    };
    try {
      await this.videos.salvar(video, [evento]);
    } catch (erro) {
      // Duas confirmações simultâneas (duplo clique, retentativa do cliente): as duas
      // leram AGUARDANDO_ENVIO, mas só a primeira grava. A segunda não cria um
      // segundo `video.enviado` no outbox, então o worker processa o vídeo uma vez só.
      if (erro instanceof ConcorrenciaError)
        throw new ConflictError('O envio deste vídeo já foi confirmado');
      throw erro;
    }
    await this.cache.remover(chaveListaDoUsuario(usuarioId));
    return paraDto(video);
  }
}
