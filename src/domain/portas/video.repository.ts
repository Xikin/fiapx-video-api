import type { Video } from '../videos/video';
import type { Mensagem } from '../mensageria/contratos';

export interface MensagemConsumida {
  id: string;
  consumidor: string;
}

export interface VideoRepository {
  criar(video: Video): Promise<void>;
  buscarPorId(id: string): Promise<Video | null>;
  listarPorUsuario(usuarioId: string): Promise<Video[]>;
  /** Grava o vídeo e as mensagens de saída no outbox, na mesma transação. */
  salvar(video: Video, saida?: Mensagem[]): Promise<void>;
  jaConsumida(mensagem: MensagemConsumida): Promise<boolean>;
  /**
   * Grava o vídeo e marca a mensagem como consumida, na mesma transação.
   * Devolve `false` se outra réplica consumiu a mesma mensagem antes.
   */
  salvarAoConsumir(video: Video, mensagem: MensagemConsumida): Promise<boolean>;
}
