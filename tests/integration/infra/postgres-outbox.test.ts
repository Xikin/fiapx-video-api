import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { criarPrisma } from '../../../src/config/prisma';
import { PrismaVideoRepository } from '../../../src/infrastructure/database/prisma-video.repository';
import { OutboxRelay } from '../../../src/infrastructure/mensageria/outbox-relay';
import type { PublicadorDeMensagens } from '../../../src/infrastructure/mensageria/rabbitmq';
import { STATUS_VIDEO, Video } from '../../../src/domain/videos/video';
import { TIPOS, type VideoEnviado } from '../../../src/domain/mensageria/contratos';
import { LoggerEspiao, USUARIO, novoVideo } from '../../support/fakes';
import { iniciarPostgres } from '../../support/containers';

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: PrismaVideoRepository;

beforeAll(async () => {
  const pg = await iniciarPostgres();
  container = pg.container;
  prisma = criarPrisma(pg.url);
  repo = new PrismaVideoRepository(prisma);
});

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE videos, outbox, mensagens_processadas');
});

const evento = (video: Video): VideoEnviado => ({
  id: crypto.randomUUID(),
  tipo: TIPOS.ENVIADO,
  versao: 1,
  videoId: video.id,
  origem: 'teste',
  ocorridaEm: new Date().toISOString(),
  dados: {
    usuarioId: video.usuarioId,
    chaveVideo: video.chaveVideo,
    nomeArquivo: 'a.mp4',
    contentType: 'video/mp4',
    tamanhoBytes: 1024,
  },
});

describe('PrismaVideoRepository (PostgreSQL real)', () => {
  it('grava e lê o vídeo sem perder campos, inclusive tamanho acima de 2 GB', async () => {
    const video = novoVideo({ tamanhoBytes: 3 * 1024 ** 3 });
    await repo.criar(video);
    expect((await repo.buscarPorId(video.id))!.paraDados()).toEqual(video.paraDados());
    expect(await repo.buscarPorId(crypto.randomUUID())).toBeNull();
  });

  it('lista só os vídeos do usuário, do mais novo para o mais antigo', async () => {
    const antigo = novoVideo({ id: crypto.randomUUID(), agora: new Date('2026-01-01') });
    const novo = novoVideo({ id: crypto.randomUUID(), agora: new Date('2026-02-01') });
    const deOutro = novoVideo({ id: crypto.randomUUID(), usuarioId: 'outro' });
    for (const v of [antigo, novo, deOutro]) await repo.criar(v);

    expect((await repo.listarPorUsuario(USUARIO.id)).map((v) => v.id)).toEqual([
      novo.id,
      antigo.id,
    ]);
  });

  it('muda o status e grava o evento no outbox na mesma transação', async () => {
    const video = novoVideo();
    await repo.criar(video);
    video.confirmarEnvio(new Date());
    const mensagem = evento(video);

    await repo.salvar(video, [mensagem]);

    expect((await repo.buscarPorId(video.id))!.status).toBe(STATUS_VIDEO.NA_FILA);
    const linhas = await prisma.outbox.findMany();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      id: mensagem.id,
      routingKey: TIPOS.ENVIADO,
      publicadoEm: null,
    });
  });

  it('se o outbox falhar, o status também não muda (rollback)', async () => {
    const video = novoVideo();
    await repo.criar(video);
    const mensagem = evento(video);
    await prisma.outbox.create({ data: { id: mensagem.id, routingKey: 'x', payload: {} } });

    video.confirmarEnvio(new Date());
    await expect(repo.salvar(video, [mensagem])).rejects.toThrow();
    expect((await repo.buscarPorId(video.id))!.status).toBe(STATUS_VIDEO.AGUARDANDO_ENVIO);
  });

  it('consumo idempotente: a segunda gravação da mesma mensagem devolve false', async () => {
    const video = novoVideo();
    await repo.criar(video);
    const consumo = { id: crypto.randomUUID(), consumidor: 'video-api.resultados' };

    expect(await repo.jaConsumida(consumo)).toBe(false);
    expect(await repo.salvarAoConsumir(video, consumo)).toBe(true);
    expect(await repo.jaConsumida(consumo)).toBe(true);
    expect(await repo.salvarAoConsumir(video, consumo)).toBe(false);
    expect(await repo.salvarAoConsumir(video, { ...consumo, consumidor: 'outro' })).toBe(true);
  });

  it('erro diferente de duplicidade não é engolido', async () => {
    const fantasma = novoVideo({ id: crypto.randomUUID() });
    await expect(
      repo.salvarAoConsumir(fantasma, { id: crypto.randomUUID(), consumidor: 'c' }),
    ).rejects.toThrow();
  });
});

describe('OutboxRelay (PostgreSQL real)', () => {
  async function enfileirar(n: number) {
    for (let i = 0; i < n; i++) {
      const video = novoVideo({ id: crypto.randomUUID() });
      await repo.criar(video);
      video.confirmarEnvio(new Date());
      await repo.salvar(video, [evento(video)]);
    }
  }

  it('publica as pendentes em ordem e marca como publicadas', async () => {
    await enfileirar(3);
    const publicadas: string[] = [];
    const publicador: PublicadorDeMensagens = {
      publicar: async (routingKey, m) =>
        void publicadas.push(`${routingKey}:${(m as { id: string }).id}`),
    };
    const relay = new OutboxRelay(prisma, publicador, new LoggerEspiao());

    expect(await relay.publicarPendentes()).toBe(3);
    expect(publicadas).toHaveLength(3);
    expect(await prisma.outbox.count({ where: { publicadoEm: null } })).toBe(0);
    expect(await relay.publicarPendentes()).toBe(0);
  });

  it('com o broker fora do ar, mantém a mensagem e conta a tentativa', async () => {
    await enfileirar(2);
    const logger = new LoggerEspiao();
    const relay = new OutboxRelay(
      prisma,
      { publicar: async () => Promise.reject(new Error('down')) },
      logger,
    );

    expect(await relay.publicarPendentes()).toBe(0);
    const linhas = await prisma.outbox.findMany({ orderBy: { criadoEm: 'asc' } });
    expect(linhas.map((l) => l.tentativas)).toEqual([1, 0]);
    expect(linhas.every((l) => l.publicadoEm === null)).toBe(true);
    expect(logger.eventos('warn')).toEqual(['outbox_publicacao_adiada']);
  });

  it('duas réplicas em paralelo não publicam a mesma linha duas vezes', async () => {
    await enfileirar(20);
    const publicadas: string[] = [];
    const lento: PublicadorDeMensagens = {
      publicar: async (_k, m) => {
        await new Promise((r) => setTimeout(r, 5));
        publicadas.push((m as { id: string }).id);
      },
    };
    const opcoes = { intervaloMs: 10, lote: 5, retencaoHoras: 72 };
    const a = new OutboxRelay(prisma, lento, new LoggerEspiao(), opcoes);
    const b = new OutboxRelay(prisma, lento, new LoggerEspiao(), opcoes);

    while ((await prisma.outbox.count({ where: { publicadoEm: null } })) > 0)
      await Promise.all([a.publicarPendentes(), b.publicarPendentes()]);

    expect(publicadas).toHaveLength(20);
    expect(new Set(publicadas).size).toBe(20);
  });

  it('o ciclo agendado publica, limpa o que passou da retenção e para sem deixar trabalho pela metade', async () => {
    await enfileirar(1);
    await prisma.outbox.create({
      data: {
        id: crypto.randomUUID(),
        routingKey: 'antiga',
        payload: {},
        publicadoEm: new Date('2020-01-01'),
      },
    });
    const relay = new OutboxRelay(prisma, { publicar: async () => {} }, new LoggerEspiao(), {
      intervaloMs: 20,
      lote: 10,
      retencaoHoras: 1,
    });
    relay.iniciar();
    relay.iniciar();
    await new Promise((r) => setTimeout(r, 300));
    await relay.parar();

    expect(await prisma.outbox.count({ where: { routingKey: 'antiga' } })).toBe(0);
    expect(await prisma.outbox.count({ where: { publicadoEm: null } })).toBe(0);
  });

  it('falha no ciclo é registrada sem derrubar o processo', async () => {
    const logger = new LoggerEspiao();
    const quebrado = {
      $transaction: () => Promise.reject(new Error('db down')),
    } as unknown as PrismaClient;
    await new OutboxRelay(quebrado, { publicar: async () => {} }, logger).ciclo();
    expect(logger.eventos('error')).toEqual(['outbox_falhou']);
  });
});
