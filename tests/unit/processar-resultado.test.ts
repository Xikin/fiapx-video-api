import { beforeEach, describe, expect, it } from 'vitest';
import { ProcessarResultadoUseCase } from '../../src/application/use-cases/processar-resultado.use-case';
import { STATUS_VIDEO } from '../../src/domain/videos/video';
import { MensagemInvalidaError } from '../../src/domain/mensageria/contratos';
import { chaveListaDoUsuario } from '../../src/domain/portas/cache';
import {
  CacheEmMemoria,
  LoggerEspiao,
  NotificadorFalso,
  USUARIO,
  VideoRepositoryEmMemoria,
  novoVideo,
  relogioFixo,
} from '../support/fakes';
import { falhou, iniciado, processado } from '../support/mensagens';

let videos: VideoRepositoryEmMemoria;
let notificador: NotificadorFalso;
let cache: CacheEmMemoria;
let logger: LoggerEspiao;
let caso: ProcessarResultadoUseCase;
let videoId: string;

beforeEach(async () => {
  videos = new VideoRepositoryEmMemoria();
  notificador = new NotificadorFalso();
  cache = new CacheEmMemoria();
  logger = new LoggerEspiao();
  caso = new ProcessarResultadoUseCase(videos, notificador, cache, relogioFixo(), logger);

  const video = novoVideo();
  video.confirmarEnvio(new Date());
  await videos.criar(video);
  videoId = video.id;
});

const status = async () => (await videos.buscarPorId(videoId))!.status;

describe('ProcessarResultadoUseCase', () => {
  it('marca processando e depois concluído', async () => {
    await caso.execute(iniciado(videoId));
    expect(await status()).toBe(STATUS_VIDEO.PROCESSANDO);
    await caso.execute(processado(videoId, 'zips/x.zip', 7));
    expect((await videos.buscarPorId(videoId))!.paraDados()).toMatchObject({
      status: STATUS_VIDEO.CONCLUIDO,
      chaveZip: 'zips/x.zip',
      totalFrames: 7,
    });
  });

  it('invalida o cache da lista do usuário', async () => {
    cache.dados.set(chaveListaDoUsuario(USUARIO.id), []);
    await caso.execute(iniciado(videoId));
    expect(cache.dados.has(chaveListaDoUsuario(USUARIO.id))).toBe(false);
  });

  it('em falha, grava o motivo e avisa o usuário por e-mail', async () => {
    await caso.execute(falhou(videoId, 'codec não suportado'));
    expect(await status()).toBe(STATUS_VIDEO.FALHOU);
    expect(notificador.avisos).toEqual([
      {
        destinatario: USUARIO.email,
        nomeArquivo: 'aula 1.mp4',
        motivo: 'codec não suportado',
        videoId,
      },
    ]);
  });

  it('a mesma mensagem entregue duas vezes manda um e-mail só', async () => {
    const mensagem = falhou(videoId);
    await caso.execute(mensagem);
    await caso.execute(mensagem);
    expect(notificador.avisos).toHaveLength(1);
  });

  it('se outra réplica consumiu primeiro, não avisa de novo', async () => {
    const mensagem = falhou(videoId);
    videos.jaConsumida = async () => false;
    videos.consumidas.add(`${mensagem.id}:video-api.resultados`);
    await caso.execute(mensagem);
    expect(notificador.avisos).toHaveLength(0);
  });

  it('evento atrasado não desfaz o estado final e fica registrado', async () => {
    await caso.execute(processado(videoId));
    await caso.execute(iniciado(videoId));
    expect(await status()).toBe(STATUS_VIDEO.CONCLUIDO);
    expect(logger.eventos('warn')).toContain('resultado_ignorado');
  });

  it('falha no e-mail é registrada, mas não devolve a mensagem para a fila', async () => {
    notificador.falhar = true;
    await expect(caso.execute(falhou(videoId))).resolves.toBeUndefined();
    expect(await status()).toBe(STATUS_VIDEO.FALHOU);
    expect(logger.eventos('error')).toContain('notificacao_falhou');
  });

  it('vídeo inexistente é mensagem inválida (vai para a DLQ)', async () => {
    await expect(caso.execute(iniciado('99999999-9999-4999-8999-999999999999'))).rejects.toThrow(
      MensagemInvalidaError,
    );
  });

  it('mensagem fora do contrato é inválida', async () => {
    await expect(caso.execute({ tipo: 'video.processado' })).rejects.toThrow(MensagemInvalidaError);
  });
});
