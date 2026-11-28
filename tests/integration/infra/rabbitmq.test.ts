import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type ChannelModel } from 'amqplib';
import type { StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import {
  RabbitMQ,
  filaDeMortas,
  filaDeRetentativa,
} from '../../../src/infrastructure/mensageria/rabbitmq';
import { MensagemInvalidaError } from '../../../src/domain/mensageria/contratos';
import { LoggerEspiao } from '../../support/fakes';
import { esperar, iniciarRabbitMQ } from '../../support/containers';

const EXCHANGE = 'fiapx.videos.teste';
let container: StartedRabbitMQContainer;
let url: string;
let inspecao: ChannelModel;

beforeAll(async () => {
  ({ container, url } = await iniciarRabbitMQ());
  inspecao = await connect(url);
});

afterAll(async () => {
  await inspecao?.close();
  await container?.stop();
});

async function contar(fila: string): Promise<number> {
  const canal = await inspecao.createChannel();
  try {
    return (await canal.checkQueue(fila)).messageCount;
  } finally {
    await canal.close();
  }
}

function rabbit(logger = new LoggerEspiao()) {
  return new RabbitMQ({
    url,
    exchange: EXCHANGE,
    servico: 'teste',
    maxTentativas: 3,
    atrasoRetentativaMs: 50,
    logger,
  });
}

const mensagem = (tipo: string) => ({
  id: crypto.randomUUID(),
  tipo,
  videoId: crypto.randomUUID(),
});

describe('RabbitMQ (broker real)', () => {
  it('entrega ao consumidor certo pelo routing key e faz ack', async () => {
    const recebidas: unknown[] = [];
    const mq = rabbit();
    mq.registrar({
      fila: 'teste.entrega',
      bindings: ['video.enviado'],
      tratar: async (m) => void recebidas.push(m),
    });
    await mq.conectar();
    await esperar(async () => mq.conectado);

    const m = mensagem('video.enviado');
    await mq.publicar('video.enviado', m);

    await esperar(async () => recebidas.length === 1);
    expect(recebidas[0]).toEqual(m);
    expect(await contar('teste.entrega')).toBe(0);
    await mq.encerrar();
  });

  it('erro passageiro volta pela fila de retentativa e depois é tratado', async () => {
    let chamadas = 0;
    const mq = rabbit();
    mq.registrar({
      fila: 'teste.retentativa',
      bindings: ['video.processado'],
      tratar: async () => {
        chamadas++;
        if (chamadas < 2) throw new Error('banco ocupado');
      },
    });
    await mq.conectar();
    await esperar(async () => mq.conectado);

    await mq.publicar('video.processado', mensagem('video.processado'));
    await esperar(async () => chamadas === 2);
    expect(await contar(filaDeMortas('teste.retentativa'))).toBe(0);
    await mq.encerrar();
  });

  it('esgotadas as tentativas, a mensagem vai para a DLQ', async () => {
    const logger = new LoggerEspiao();
    let chamadas = 0;
    const mq = rabbit(logger);
    mq.registrar({
      fila: 'teste.esgota',
      bindings: ['video.falhou'],
      tratar: async () => {
        chamadas++;
        throw new Error('sempre falha');
      },
    });
    await mq.conectar();
    await esperar(async () => mq.conectado);

    await mq.publicar('video.falhou', mensagem('video.falhou'));
    await esperar(async () => (await contar(filaDeMortas('teste.esgota'))) === 1);
    expect(chamadas).toBe(3);
    expect(await contar(filaDeRetentativa('teste.esgota'))).toBe(0);
    expect(logger.eventos('warn').filter((e) => e === 'mensagem_falhou')).toHaveLength(2);
    expect(logger.eventos('error')).toContain('mensagem_falhou');
    await mq.encerrar();
  });

  it('mensagem inválida ou JSON quebrado vai direto para a DLQ, sem retentativa', async () => {
    let chamadas = 0;
    const mq = rabbit();
    mq.registrar({
      fila: 'teste.invalida',
      bindings: ['video.invalido'],
      tratar: async () => {
        chamadas++;
        throw new MensagemInvalidaError('fora do contrato');
      },
    });
    await mq.conectar();
    await esperar(async () => mq.conectado);

    await mq.publicar('video.invalido', mensagem('video.invalido'));
    const canal = await inspecao.createChannel();
    canal.sendToQueue('teste.invalida', Buffer.from('{não é json'));
    await canal.close();

    await esperar(async () => (await contar(filaDeMortas('teste.invalida'))) === 2);
    expect(chamadas).toBe(1);
    await mq.encerrar();
  });

  it('publicar sem nenhuma fila ligada ao routing key falha, para o outbox tentar de novo', async () => {
    const mq = rabbit();
    await mq.conectar();
    await esperar(async () => mq.conectado);
    await expect(mq.publicar('ninguem.escuta', mensagem('x'))).rejects.toThrow(/Nenhuma fila/);
    await mq.encerrar();
  });

  it('publicar desconectado falha na hora', async () => {
    const mq = rabbit();
    expect(mq.conectado).toBe(false);
    await expect(mq.publicar('x', mensagem('x'))).rejects.toThrow('RabbitMQ indisponível');
    await mq.encerrar();
  });
});
