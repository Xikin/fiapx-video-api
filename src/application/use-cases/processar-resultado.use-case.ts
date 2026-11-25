import type { VideoRepository } from '../../domain/portas/video.repository';
import type { Notificador } from '../../domain/portas/notificador';
import { chaveListaDoUsuario, type Cache } from '../../domain/portas/cache';
import type { Logger } from '../../domain/portas/logger';
import type { Relogio } from '../../domain/portas/relogio';
import {
  MensagemInvalidaError,
  TIPOS,
  lerResultadoDoWorker,
  type ResultadoDoWorker,
} from '../../domain/mensageria/contratos';
import type { Video } from '../../domain/videos/video';

export const CONSUMIDOR_RESULTADOS = 'video-api.resultados';

/**
 * Consome os eventos do fiapx-video-processor e atualiza o status do vídeo.
 * Idempotente: a mesma mensagem entregue duas vezes muda o vídeo uma vez só.
 */
export class ProcessarResultadoUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly notificador: Notificador,
    private readonly cache: Cache,
    private readonly relogio: Relogio,
    private readonly logger: Logger,
  ) {}

  async execute(bruto: unknown): Promise<void> {
    const mensagem = lerResultadoDoWorker(bruto);
    const consumo = { id: mensagem.id, consumidor: CONSUMIDOR_RESULTADOS };
    if (await this.videos.jaConsumida(consumo)) return;

    const video = await this.videos.buscarPorId(mensagem.videoId);
    if (!video) throw new MensagemInvalidaError(`vídeo ${mensagem.videoId} não existe`);

    const mudou = this.aplicar(video, mensagem);
    const primeiraVez = await this.videos.salvarAoConsumir(video, consumo);
    await this.cache.remover(chaveListaDoUsuario(video.usuarioId));

    if (!mudou) {
      this.logger.warn(
        {
          evento: 'resultado_ignorado',
          videoId: video.id,
          tipo: mensagem.tipo,
          status: video.status,
        },
        'evento chegou depois de um estado final; status mantido',
      );
      return;
    }
    if (primeiraVez && mensagem.tipo === TIPOS.FALHOU)
      await this.avisar(video, mensagem.dados.motivo);
  }

  private aplicar(video: Video, mensagem: ResultadoDoWorker): boolean {
    const agora = this.relogio.agora();
    switch (mensagem.tipo) {
      case TIPOS.PROCESSAMENTO_INICIADO:
        return video.iniciarProcessamento(agora);
      case TIPOS.PROCESSADO:
        return video.concluir(mensagem.dados, agora);
      case TIPOS.FALHOU:
        return video.falhar(mensagem.dados.motivo, agora);
    }
  }

  /** Falha no e-mail não volta a mensagem para a fila: o status já foi gravado. */
  private async avisar(video: Video, motivo: string): Promise<void> {
    const dados = video.paraDados();
    try {
      await this.notificador.avisarFalha({
        destinatario: dados.emailUsuario,
        nomeArquivo: dados.nomeArquivo,
        motivo,
        videoId: dados.id,
      });
      this.logger.info(
        { evento: 'falha_notificada', videoId: dados.id },
        'usuário avisado da falha',
      );
    } catch (erro) {
      this.logger.error(
        {
          evento: 'notificacao_falhou',
          videoId: dados.id,
          erro: erro instanceof Error ? erro.message : String(erro),
        },
        'não foi possível avisar o usuário da falha',
      );
    }
  }
}
