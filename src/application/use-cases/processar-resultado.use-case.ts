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
import { ConcorrenciaError } from '../../shared/errors';

export const CONSUMIDOR_RESULTADOS = 'video-api.resultados';

/**
 * Quantas vezes reler e reaplicar quando outro consumidor gravou o mesmo vídeo
 * no meio do caminho. Cada conflito significa que o vídeo andou na máquina de
 * estados (que tem 5 status), então poucas tentativas bastam. Se esgotar, o
 * erro sobe e a mensagem vai para a fila de retentativa do RabbitMQ.
 */
export const MAX_TENTATIVAS_CONCORRENCIA = 3;

interface Consumo {
  id: string;
  consumidor: string;
}

/**
 * Consome os eventos do fiapx-video-processor e atualiza o status do vídeo.
 * Idempotente: a mesma mensagem entregue duas vezes muda o vídeo uma vez só.
 * Seguro com consumo em paralelo: mensagens diferentes do mesmo vídeo tratadas
 * ao mesmo tempo não se sobrescrevem (ver `VideoRepository`).
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
    // Fora do laço: mensagem fora do contrato é definitiva, não adianta reler o vídeo.
    const mensagem = lerResultadoDoWorker(bruto);
    const consumo: Consumo = { id: mensagem.id, consumidor: CONSUMIDOR_RESULTADOS };

    for (let tentativa = 1; ; tentativa++) {
      try {
        return await this.aplicarUmaVez(mensagem, consumo);
      } catch (erro) {
        if (!(erro instanceof ConcorrenciaError) || tentativa >= MAX_TENTATIVAS_CONCORRENCIA)
          throw erro;
        this.logger.warn(
          { evento: 'conflito_de_concorrencia', videoId: mensagem.videoId, tentativa },
          'vídeo alterado em paralelo; relendo e aplicando de novo',
        );
      }
    }
  }

  /** Uma tentativa: lê o estado atual, aplica o evento e grava junto com a marca de consumida. */
  private async aplicarUmaVez(mensagem: ResultadoDoWorker, consumo: Consumo): Promise<void> {
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
