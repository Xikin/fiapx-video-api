import type { MensagemConsumida, VideoRepository } from '../../src/domain/portas/video.repository';
import type { Armazenamento, UrlAssinada } from '../../src/domain/portas/armazenamento';
import type { AvisoDeFalha, Notificador } from '../../src/domain/portas/notificador';
import type { Cache } from '../../src/domain/portas/cache';
import type { Logger } from '../../src/domain/portas/logger';
import type { GeradorDeId, Relogio } from '../../src/domain/portas/relogio';
import type { Mensagem } from '../../src/domain/mensageria/contratos';
import { Video } from '../../src/domain/videos/video';
import { ConcorrenciaError } from '../../src/shared/errors';

export class VideoRepositoryEmMemoria implements VideoRepository {
  readonly videos = new Map<string, ReturnType<Video['paraDados']>>();
  readonly outbox: Mensagem[] = [];
  readonly consumidas = new Set<string>();

  async criar(video: Video) {
    this.videos.set(video.id, video.paraDados());
    video.marcarPersistido();
  }
  async buscarPorId(id: string) {
    const dados = this.videos.get(id);
    return dados ? Video.restaurar(dados) : null;
  }
  async listarPorUsuario(usuarioId: string) {
    return [...this.videos.values()]
      .filter((v) => v.usuarioId === usuarioId)
      .sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime())
      .map((v) => Video.restaurar(v));
  }
  async contarAguardandoEnvioDesde(usuarioId: string, desde: Date) {
    return [...this.videos.values()].filter(
      (v) =>
        v.usuarioId === usuarioId &&
        v.status === 'AGUARDANDO_ENVIO' &&
        v.criadoEm.getTime() >= desde.getTime(),
    ).length;
  }
  async salvar(video: Video, saida: Mensagem[] = []) {
    this.garantirSemConflito(video);
    this.videos.set(video.id, video.paraDados());
    this.outbox.push(...saida);
    video.marcarPersistido();
  }
  async jaConsumida(m: MensagemConsumida) {
    return this.consumidas.has(`${m.id}:${m.consumidor}`);
  }
  async salvarAoConsumir(video: Video, m: MensagemConsumida) {
    const chave = `${m.id}:${m.consumidor}`;
    if (this.consumidas.has(chave)) return false;
    // Mesma ordem da transação real: conflito não deixa a mensagem marcada como consumida.
    this.garantirSemConflito(video);
    this.consumidas.add(chave);
    this.videos.set(video.id, video.paraDados());
    video.marcarPersistido();
    return true;
  }

  /** Mesma regra do PrismaVideoRepository: só grava se o status guardado for o esperado. */
  private garantirSemConflito(video: Video) {
    if (this.videos.get(video.id)?.status !== video.statusPersistido) throw new ConcorrenciaError();
  }
}

export class ArmazenamentoFalso implements Armazenamento {
  readonly objetos = new Map<string, number>();
  async urlDeEnvio(chave: string, contentType: string): Promise<UrlAssinada> {
    return {
      url: `https://s3.teste/${chave}?assinatura=put`,
      metodo: 'PUT',
      cabecalhos: { 'content-type': contentType },
      expiraEm: new Date('2026-12-01T12:15:00.000Z'),
    };
  }
  async urlDeDownload(chave: string, nome: string): Promise<UrlAssinada> {
    return {
      url: `https://s3.teste/${chave}?assinatura=get&nome=${nome}`,
      metodo: 'GET',
      cabecalhos: {},
      expiraEm: new Date('2026-12-01T12:15:00.000Z'),
    };
  }
  async tamanho(chave: string) {
    return this.objetos.get(chave) ?? null;
  }
}

export class NotificadorFalso implements Notificador {
  readonly avisos: AvisoDeFalha[] = [];
  falhar = false;
  async avisarFalha(aviso: AvisoDeFalha) {
    if (this.falhar) throw new Error('SMTP fora do ar');
    this.avisos.push(aviso);
  }
}

export class CacheEmMemoria implements Cache {
  readonly dados = new Map<string, unknown>();
  async obter<T>(chave: string) {
    return (this.dados.get(chave) as T) ?? null;
  }
  async definir(chave: string, valor: unknown) {
    this.dados.set(chave, valor);
  }
  async remover(chave: string) {
    this.dados.delete(chave);
  }
}

export class LoggerEspiao implements Logger {
  readonly registros: { nivel: string; obj: object; msg?: string }[] = [];
  info = (obj: object, msg?: string) => void this.registros.push({ nivel: 'info', obj, msg });
  warn = (obj: object, msg?: string) => void this.registros.push({ nivel: 'warn', obj, msg });
  error = (obj: object, msg?: string) => void this.registros.push({ nivel: 'error', obj, msg });
  eventos(nivel?: string) {
    return this.registros
      .filter((r) => !nivel || r.nivel === nivel)
      .map((r) => (r.obj as { evento?: string }).evento);
  }
}

export const AGORA = new Date('2026-12-01T12:00:00.000Z');
export const relogioFixo = (data = AGORA): Relogio => ({ agora: () => data });

export function idsSequenciais(): GeradorDeId {
  let n = 0;
  return {
    novo: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  };
}

export const USUARIO = { id: 'usuario-1', email: 'ana@fiapx.dev' };
export const OUTRO_USUARIO = { id: 'usuario-2', email: 'bruno@fiapx.dev' };

export function novoVideo(sobrescrever: Partial<Parameters<typeof Video.criar>[0]> = {}) {
  return Video.criar({
    id: '11111111-1111-4111-8111-111111111111',
    usuarioId: USUARIO.id,
    emailUsuario: USUARIO.email,
    nomeArquivo: 'aula 1.mp4',
    contentType: 'video/mp4',
    tamanhoBytes: 1024,
    agora: AGORA,
    ...sobrescrever,
  });
}
