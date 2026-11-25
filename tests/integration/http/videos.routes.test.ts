import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type EstadoDependencia } from '../../../src/app';
import { SolicitarEnvioUseCase } from '../../../src/application/use-cases/solicitar-envio.use-case';
import { ConfirmarEnvioUseCase } from '../../../src/application/use-cases/confirmar-envio.use-case';
import { ListarVideosUseCase } from '../../../src/application/use-cases/listar-videos.use-case';
import { ObterVideoUseCase } from '../../../src/application/use-cases/obter-video.use-case';
import { GerarDownloadUseCase } from '../../../src/application/use-cases/gerar-download.use-case';
import { ProcessarResultadoUseCase } from '../../../src/application/use-cases/processar-resultado.use-case';
import {
  ArmazenamentoFalso,
  CacheEmMemoria,
  LoggerEspiao,
  NotificadorFalso,
  OUTRO_USUARIO,
  USUARIO,
  VideoRepositoryEmMemoria,
  idsSequenciais,
  relogioFixo,
} from '../../support/fakes';
import { falhou, processado } from '../../support/mensagens';
import { EMISSOR_TESTE, SEGREDO_TESTE, token } from '../../support/token';

let app: FastifyInstance;
let videos: VideoRepositoryEmMemoria;
let armazenamento: ArmazenamentoFalso;
let notificador: NotificadorFalso;
let processar: ProcessarResultadoUseCase;
let prontidao: Record<string, EstadoDependencia>;

const auth = (usuario = USUARIO) => ({
  authorization: `Bearer ${token({ sub: usuario.id, email: usuario.email })}`,
});

beforeAll(async () => {
  videos = new VideoRepositoryEmMemoria();
  armazenamento = new ArmazenamentoFalso();
  notificador = new NotificadorFalso();
  const cache = new CacheEmMemoria();
  const ids = idsSequenciais();
  const relogio = relogioFixo();
  processar = new ProcessarResultadoUseCase(
    videos,
    notificador,
    cache,
    relogio,
    new LoggerEspiao(),
  );

  app = await buildApp({
    casos: {
      solicitarEnvio: new SolicitarEnvioUseCase(
        videos,
        armazenamento,
        cache,
        ids,
        relogio,
        50 * 1024 * 1024,
      ),
      confirmarEnvio: new ConfirmarEnvioUseCase(videos, armazenamento, cache, ids, relogio),
      listarVideos: new ListarVideosUseCase(videos, cache),
      obterVideo: new ObterVideoUseCase(videos),
      gerarDownload: new GerarDownloadUseCase(videos, armazenamento),
    },
    jwt: { segredo: SEGREDO_TESTE, emissor: EMISSOR_TESTE },
    prontidao: async () => prontidao,
    swagger: true,
    limitePorMinuto: 1000,
  });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  prontidao = { banco: 'ok', mensageria: 'ok' };
});

async function enviarVideo(usuario = USUARIO, tamanhoBytes = 2048) {
  const res = await app.inject({
    method: 'POST',
    url: '/videos',
    headers: auth(usuario),
    payload: { nomeArquivo: 'demo.mp4', contentType: 'video/mp4', tamanhoBytes },
  });
  expect(res.statusCode).toBe(201);
  const corpo = res.json();
  armazenamento.objetos.set(`videos/${usuario.id}/${corpo.video.id}/demo.mp4`, tamanhoBytes);
  return corpo as { video: { id: string }; envio: { url: string; expiraEm: string } };
}

describe('fluxo completo pela API', () => {
  it('envia, confirma, acompanha o status e baixa o zip', async () => {
    const { video, envio } = await enviarVideo();
    expect(envio.expiraEm).toBe('2026-12-01T12:15:00.000Z');

    const confirmado = await app.inject({
      method: 'POST',
      url: `/videos/${video.id}/confirmar-envio`,
      headers: auth(),
    });
    expect(confirmado.statusCode).toBe(202);
    expect(confirmado.json().status).toBe('NA_FILA');
    expect(videos.outbox.at(-1)?.tipo).toBe('video.enviado');

    const antes = await app.inject({
      method: 'GET',
      url: `/videos/${video.id}/download`,
      headers: auth(),
    });
    expect(antes.statusCode).toBe(409);

    await processar.execute(processado(video.id));

    const lista = await app.inject({ method: 'GET', url: '/videos', headers: auth() });
    expect(lista.json().videos.find((v: { id: string }) => v.id === video.id)).toMatchObject({
      status: 'CONCLUIDO',
      downloadDisponivel: true,
      totalFrames: 42,
    });

    const download = await app.inject({
      method: 'GET',
      url: `/videos/${video.id}/download`,
      headers: auth(),
    });
    expect(download.statusCode).toBe(200);
    expect(download.json()).toMatchObject({ metodo: 'GET' });
  });

  it('mostra o motivo quando o processamento falha', async () => {
    const { video } = await enviarVideo();
    await app.inject({
      method: 'POST',
      url: `/videos/${video.id}/confirmar-envio`,
      headers: auth(),
    });
    await processar.execute(falhou(video.id, 'sem frames'));

    const res = await app.inject({ method: 'GET', url: `/videos/${video.id}`, headers: auth() });
    expect(res.json()).toMatchObject({
      status: 'FALHOU',
      motivoFalha: 'sem frames',
      downloadDisponivel: false,
    });
    expect(notificador.avisos.at(-1)?.videoId).toBe(video.id);
  });
});

describe('autenticação', () => {
  it.each([
    ['sem token', {}],
    ['token malformado', { authorization: 'Bearer abc' }],
    [
      'outro segredo',
      { authorization: `Bearer ${token({ sub: 'x' }, { segredo: 'z'.repeat(40) })}` },
    ],
    ['outro emissor', { authorization: `Bearer ${token({ sub: 'x' }, { emissor: 'intruso' })}` }],
    ['expirado', { authorization: `Bearer ${token({ sub: 'x' }, { expirado: true })}` }],
    ['sem e-mail', { authorization: `Bearer ${token({ sub: 'x', email: '' })}` }],
  ])('401 com %s', async (_caso, headers) => {
    const res = await app.inject({ method: 'GET', url: '/videos', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });
});

describe('isolamento entre usuários', () => {
  it('um usuário não vê, não confirma e não baixa o vídeo de outro', async () => {
    const { video } = await enviarVideo(USUARIO);
    for (const [method, url] of [
      ['GET', `/videos/${video.id}`],
      ['POST', `/videos/${video.id}/confirmar-envio`],
      ['GET', `/videos/${video.id}/download`],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(OUTRO_USUARIO) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const lista = await app.inject({ method: 'GET', url: '/videos', headers: auth(OUTRO_USUARIO) });
    expect(lista.json().videos.map((v: { id: string }) => v.id)).not.toContain(video.id);
  });
});

describe('validação', () => {
  it.each([
    [{ nomeArquivo: 'a.exe', contentType: 'application/x-msdownload', tamanhoBytes: 10 }],
    [{ nomeArquivo: '', contentType: 'video/mp4', tamanhoBytes: 10 }],
    [{ nomeArquivo: 'a.mp4', contentType: 'video/mp4', tamanhoBytes: 0 }],
    [{ nomeArquivo: 'a.mp4', contentType: 'video/mp4' }],
  ])('422 para corpo inválido %#', async (payload) => {
    const res = await app.inject({ method: 'POST', url: '/videos', headers: auth(), payload });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.length).toBeGreaterThan(0);
  });

  it('422 acima do tamanho máximo, com a regra de negócio na mensagem', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/videos',
      headers: auth(),
      payload: { nomeArquivo: 'a.mp4', contentType: 'video/mp4', tamanhoBytes: 51 * 1024 * 1024 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'BUSINESS_ERROR' });
  });

  it('422 para id que não é UUID', async () => {
    const res = await app.inject({ method: 'GET', url: '/videos/123', headers: auth() });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0]).toMatchObject({ campo: 'id' });
  });

  it('confirmar antes do upload responde 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/videos',
      headers: auth(),
      payload: { nomeArquivo: 'x.mp4', contentType: 'video/mp4', tamanhoBytes: 5 },
    });
    const confirmar = await app.inject({
      method: 'POST',
      url: `/videos/${res.json().video.id}/confirmar-envio`,
      headers: auth(),
    });
    expect(confirmar.statusCode).toBe(422);
  });
});

describe('saúde, documentação e rastreio', () => {
  it('liveness responde ok', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });

  it('readiness responde 503 se uma dependência cair', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    prontidao = { banco: 'indisponivel', mensageria: 'ok' };
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('degradado');
  });

  it('publica o OpenAPI com o esquema bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/videos/{id}/download');
  });

  it('devolve o x-request-id recebido', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('404 de rota inexistente segue o formato de erro', async () => {
    const res = await app.inject({ method: 'GET', url: '/nada' });
    expect(res.statusCode).toBe(404);
  });
});

describe('limite de requisições', () => {
  it('responde 429 depois do limite por IP', async () => {
    const limitado = await buildApp({
      casos: { listarVideos: { execute: async () => [] } } as never,
      jwt: { segredo: SEGREDO_TESTE, emissor: EMISSOR_TESTE },
      limitePorMinuto: 2,
    });
    const chamar = () => limitado.inject({ method: 'GET', url: '/health' });
    await chamar();
    await chamar();
    const res = await chamar();
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMITED');
    await limitado.close();
  });

  it('erro inesperado vira 500 sem vazar detalhes', async () => {
    const quebrado = await buildApp({
      casos: {
        listarVideos: {
          execute: async () => {
            throw new Error('senha=123 no stack');
          },
        },
      } as never,
      jwt: { segredo: SEGREDO_TESTE, emissor: EMISSOR_TESTE },
    });
    const res = await quebrado.inject({ method: 'GET', url: '/videos', headers: auth() });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('senha');
    await quebrado.close();
  });
});
