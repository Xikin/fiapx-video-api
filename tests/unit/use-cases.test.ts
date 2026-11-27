import { beforeEach, describe, expect, it } from 'vitest';
import { SolicitarEnvioUseCase } from '../../src/application/use-cases/solicitar-envio.use-case';
import { ConfirmarEnvioUseCase } from '../../src/application/use-cases/confirmar-envio.use-case';
import { ListarVideosUseCase } from '../../src/application/use-cases/listar-videos.use-case';
import { ObterVideoUseCase } from '../../src/application/use-cases/obter-video.use-case';
import { GerarDownloadUseCase } from '../../src/application/use-cases/gerar-download.use-case';
import { STATUS_VIDEO } from '../../src/domain/videos/video';
import { TIPOS } from '../../src/domain/mensageria/contratos';
import { chaveListaDoUsuario } from '../../src/domain/portas/cache';
import {
  BusinessError,
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
} from '../../src/shared/errors';
import {
  AGORA,
  ArmazenamentoFalso,
  CacheEmMemoria,
  OUTRO_USUARIO,
  USUARIO,
  VideoRepositoryEmMemoria,
  idsSequenciais,
  novoVideo,
  relogioFixo,
} from '../support/fakes';

const MB = 1024 * 1024;

let videos: VideoRepositoryEmMemoria;
let armazenamento: ArmazenamentoFalso;
let cache: CacheEmMemoria;

beforeEach(() => {
  videos = new VideoRepositoryEmMemoria();
  armazenamento = new ArmazenamentoFalso();
  cache = new CacheEmMemoria();
});

describe('SolicitarEnvioUseCase', () => {
  const caso = () =>
    new SolicitarEnvioUseCase(videos, armazenamento, cache, idsSequenciais(), relogioFixo(), {
      tamanhoMaximoBytes: 10 * MB,
    });

  it('registra o vídeo e devolve a URL de envio', async () => {
    cache.dados.set(chaveListaDoUsuario(USUARIO.id), []);
    const saida = await caso().execute({
      usuario: USUARIO,
      nomeArquivo: 'aula.mp4',
      contentType: 'video/mp4',
      tamanhoBytes: 2 * MB,
    });

    expect(saida.video.status).toBe(STATUS_VIDEO.AGUARDANDO_ENVIO);
    expect(saida.envio).toMatchObject({
      metodo: 'PUT',
      cabecalhos: { 'content-type': 'video/mp4' },
    });
    expect(saida.envio.url).toContain(`videos/${USUARIO.id}/${saida.video.id}/aula.mp4`);
    expect(videos.videos.size).toBe(1);
    expect(cache.dados.has(chaveListaDoUsuario(USUARIO.id))).toBe(false);
  });

  it('recusa tipo que não é vídeo', async () => {
    await expect(
      caso().execute({
        usuario: USUARIO,
        nomeArquivo: 'a.exe',
        contentType: 'application/x-msdownload',
        tamanhoBytes: 1,
      }),
    ).rejects.toThrow(BusinessError);
    expect(videos.videos.size).toBe(0);
  });

  it('recusa vídeo acima do limite', async () => {
    await expect(
      caso().execute({
        usuario: USUARIO,
        nomeArquivo: 'a.mp4',
        contentType: 'video/mp4',
        tamanhoBytes: 11 * MB,
      }),
    ).rejects.toThrow(/limite de 10 MB/);
  });

  describe('cota de envios em aberto', () => {
    const comCota = (maximo: number) =>
      new SolicitarEnvioUseCase(videos, armazenamento, cache, idsSequenciais(), relogioFixo(), {
        tamanhoMaximoBytes: 10 * MB,
        pendentes: { maximo, janelaSegundos: 900 },
      });
    const pedido = {
      usuario: USUARIO,
      nomeArquivo: 'a.mp4',
      contentType: 'video/mp4',
      tamanhoBytes: 1,
    };

    it('responde 429 ao passar do máximo e não cria o vídeo', async () => {
      const caso = comCota(2);
      await caso.execute(pedido);
      await caso.execute(pedido);
      await expect(caso.execute(pedido)).rejects.toThrow(TooManyRequestsError);
      expect(videos.videos.size).toBe(2);
    });

    it('a cota é por usuário', async () => {
      const caso = comCota(1);
      await caso.execute(pedido);
      await expect(caso.execute({ ...pedido, usuario: OUTRO_USUARIO })).resolves.toBeDefined();
    });

    it('envio abandonado fora da janela não conta', async () => {
      // Vídeo criado há 1 hora: a URL dele (TTL 15 min) já expirou.
      await videos.criar(novoVideo({ agora: new Date(AGORA.getTime() - 3600_000) }));
      await expect(comCota(1).execute(pedido)).resolves.toBeDefined();
    });

    it('envio já confirmado não conta', async () => {
      const confirmado = novoVideo();
      confirmado.confirmarEnvio(AGORA);
      await videos.criar(confirmado);
      await expect(comCota(1).execute(pedido)).resolves.toBeDefined();
    });
  });
});

describe('ConfirmarEnvioUseCase', () => {
  const caso = () =>
    new ConfirmarEnvioUseCase(videos, armazenamento, cache, idsSequenciais(), relogioFixo());

  it('duas confirmações simultâneas geram um único video.enviado', async () => {
    const video = novoVideo();
    await videos.criar(video);
    armazenamento.objetos.set(video.chaveVideo, 1024);

    // Duplo clique: as duas chamadas leem AGUARDANDO_ENVIO antes de qualquer gravação.
    const resultados = await Promise.allSettled([
      caso().execute(USUARIO.id, video.id),
      caso().execute(USUARIO.id, video.id),
    ]);

    expect(resultados.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const recusada = resultados.find((r) => r.status === 'rejected');
    expect((recusada as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    expect(videos.outbox).toHaveLength(1);
  });

  it('coloca o vídeo na fila e grava video.enviado no outbox', async () => {
    const video = novoVideo();
    await videos.criar(video);
    armazenamento.objetos.set(video.chaveVideo, 1024);

    const dto = await caso().execute(USUARIO.id, video.id);

    expect(dto.status).toBe(STATUS_VIDEO.NA_FILA);
    expect(videos.outbox).toHaveLength(1);
    expect(videos.outbox[0]).toMatchObject({
      tipo: TIPOS.ENVIADO,
      videoId: video.id,
      dados: { chaveVideo: video.chaveVideo, tamanhoBytes: 1024, usuarioId: USUARIO.id },
    });
  });

  it('não enfileira se o arquivo não chegou ao S3', async () => {
    const video = novoVideo();
    await videos.criar(video);
    await expect(caso().execute(USUARIO.id, video.id)).rejects.toThrow(/ainda não chegou/);
    expect(videos.outbox).toHaveLength(0);
  });

  it('não enfileira se o tamanho enviado difere do declarado', async () => {
    const video = novoVideo();
    await videos.criar(video);
    armazenamento.objetos.set(video.chaveVideo, 999);
    await expect(caso().execute(USUARIO.id, video.id)).rejects.toThrow(/999 bytes/);
  });

  it('não confirma duas vezes', async () => {
    const video = novoVideo();
    await videos.criar(video);
    armazenamento.objetos.set(video.chaveVideo, 1024);
    await caso().execute(USUARIO.id, video.id);
    await expect(caso().execute(USUARIO.id, video.id)).rejects.toThrow(ConflictError);
    expect(videos.outbox).toHaveLength(1);
  });

  it('vídeo de outro usuário responde como inexistente', async () => {
    const video = novoVideo();
    await videos.criar(video);
    await expect(caso().execute(OUTRO_USUARIO.id, video.id)).rejects.toThrow(NotFoundError);
  });
});

describe('ListarVideosUseCase', () => {
  it('lista só os vídeos do usuário e guarda em cache', async () => {
    await videos.criar(novoVideo());
    await videos.criar(
      novoVideo({ id: '22222222-2222-4222-8222-222222222222', usuarioId: OUTRO_USUARIO.id }),
    );
    const caso = new ListarVideosUseCase(videos, cache);

    const lista = await caso.execute(USUARIO.id);
    expect(lista.map((v) => v.id)).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(cache.dados.get(chaveListaDoUsuario(USUARIO.id))).toEqual(lista);
  });

  it('responde do cache sem ir ao banco', async () => {
    const emCache = [{ id: 'do-cache' }];
    cache.dados.set(chaveListaDoUsuario(USUARIO.id), emCache);
    await videos.criar(novoVideo());
    expect(await new ListarVideosUseCase(videos, cache).execute(USUARIO.id)).toBe(emCache);
  });
});

describe('ObterVideoUseCase', () => {
  it('devolve o vídeo do dono e esconde o de outro usuário', async () => {
    const video = novoVideo();
    await videos.criar(video);
    const caso = new ObterVideoUseCase(videos);
    expect((await caso.execute(USUARIO.id, video.id)).nomeArquivo).toBe('aula 1.mp4');
    await expect(caso.execute(OUTRO_USUARIO.id, video.id)).rejects.toThrow(NotFoundError);
    await expect(caso.execute(USUARIO.id, 'nao-existe')).rejects.toThrow(NotFoundError);
  });
});

describe('GerarDownloadUseCase', () => {
  it('gera URL do zip com nome amigável quando o vídeo está concluído', async () => {
    const video = novoVideo();
    video.confirmarEnvio(new Date());
    video.concluir({ chaveZip: `zips/${video.id}.zip`, totalFrames: 3 }, new Date());
    await videos.criar(video);

    const url = await new GerarDownloadUseCase(videos, armazenamento).execute(USUARIO.id, video.id);
    expect(url.metodo).toBe('GET');
    expect(url.url).toContain(`zips/${video.id}.zip`);
    expect(url.url).toContain('aula-1-frames.zip');
  });

  it('não assina URL para chave de zip gravada fora da pasta do vídeo', async () => {
    const video = novoVideo();
    video.confirmarEnvio(new Date());
    // Simula uma linha antiga gravada antes da validação no consumidor.
    const chaveDeOutroUsuario = `videos/${OUTRO_USUARIO.id}/x/aula.mp4`;
    video.concluir({ chaveZip: chaveDeOutroUsuario, totalFrames: 3 }, new Date());
    await videos.criar(video);

    await expect(
      new GerarDownloadUseCase(videos, armazenamento).execute(USUARIO.id, video.id),
    ).rejects.toThrow(ConflictError);
  });

  it('recusa enquanto o zip não está pronto', async () => {
    const video = novoVideo();
    await videos.criar(video);
    await expect(
      new GerarDownloadUseCase(videos, armazenamento).execute(USUARIO.id, video.id),
    ).rejects.toThrow(/ainda não está pronto/);
  });
});
