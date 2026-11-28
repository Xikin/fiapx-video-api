import { describe, expect, it, vi } from 'vitest';
import type { Channel, ConsumeMessage } from 'amqplib';
import {
  RabbitMQ,
  filaDeMortas,
  filaDeRetentativa,
  lerTentativa,
  type Consumidor,
} from '../../src/infrastructure/mensageria/rabbitmq';
import { LoggerEspiao } from '../support/fakes';

/**
 * Testes do caminho de consumo sem broker: o canal é um dublê e `receber`
 * (privado) é chamado direto. O comportamento com o RabbitMQ real (retentativa
 * e DLQ) fica em tests/integration/infra/rabbitmq.test.ts.
 */

const FILA = 'teste.resultados';

/** Canal fechado: a amqplib lança IllegalOperationError em ack/nack. */
function canalFechado() {
  const fechado = () => {
    throw new Error('Channel closed');
  };
  return { ack: vi.fn(fechado), nack: vi.fn(fechado) };
}

function entrega(cabecalhos: Record<string, unknown> = {}, corpo: unknown = {}): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(corpo)),
    fields: { routingKey: 'video.processado' },
    properties: { headers: cabecalhos, messageId: 'm-1' },
  } as unknown as ConsumeMessage;
}

/** Acesso ao método privado só para o teste. */
type ComReceber = {
  receber(canal: Channel, consumidor: Consumidor, entrega: ConsumeMessage): Promise<void>;
};

function montar(tratar: Consumidor['tratar']) {
  const logger = new LoggerEspiao();
  const rabbit = new RabbitMQ({
    url: 'amqp://nao-usado',
    exchange: 'x',
    servico: 'teste',
    maxTentativas: 3,
    atrasoRetentativaMs: 10,
    logger,
  });
  const consumidor: Consumidor = { fila: FILA, bindings: [], tratar };
  return { logger, rabbit: rabbit as unknown as ComReceber, consumidor };
}

describe('lerTentativa', () => {
  it.each([
    [undefined, 0],
    [null, 0],
    ['', 0],
    ['abc', 0],
    [Number.NaN, 0],
    [-5, 0],
    [1.5, 0],
    ['2', 2],
    [3, 3],
  ])('%j vira %j', (valor, esperado) => {
    expect(lerTentativa(valor)).toBe(esperado);
  });
});

describe('RabbitMQ.receber com o canal fechado', () => {
  it('mensagem tratada com sucesso: ack falho não lança nem vira falha de tratamento', async () => {
    const { logger, rabbit, consumidor } = montar(async () => {});
    const canal = canalFechado();

    await expect(
      rabbit.receber(canal as unknown as Channel, consumidor, entrega()),
    ).resolves.toBeUndefined();

    expect(canal.ack).toHaveBeenCalledTimes(1);
    expect(canal.nack).not.toHaveBeenCalled();
    expect(logger.eventos('warn')).toEqual(['canal_fechado']);
    expect(logger.eventos('error')).toEqual([]); // não aparece como "mensagem_falhou"
  });

  it('tratamento falhou e o broker caiu: nack falho não lança (antes derrubava o processo)', async () => {
    const { logger, rabbit, consumidor } = montar(async () => {
      throw new Error('banco fora do ar');
    });
    const canal = canalFechado();

    // Sem `conectar()`, o canal de publicação é null: `reencaminhar` falha como numa queda.
    await expect(
      rabbit.receber(canal as unknown as Channel, consumidor, entrega()),
    ).resolves.toBeUndefined();

    expect(canal.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(logger.eventos('warn')).toEqual(['canal_fechado']);
  });
});

describe('RabbitMQ.receber decide o destino pela tentativa', () => {
  /** Canal aberto e um canal de publicação falso que registra para onde a mensagem foi. */
  function comPublicacao(tratar: Consumidor['tratar']) {
    const montado = montar(tratar);
    const destinos: string[] = [];
    const publicacao = {
      sendToQueue: (fila: string, _c: Buffer, _p: unknown, cb: (erro: unknown) => void) => {
        destinos.push(fila);
        cb(null);
      },
    };
    (montado.rabbit as unknown as { canalDePublicacao: unknown }).canalDePublicacao = publicacao;
    const canal = { ack: vi.fn(), nack: vi.fn() };
    return { ...montado, destinos, canal: canal as unknown as Channel };
  }

  const falha = async () => {
    throw new Error('erro temporário');
  };

  it('cabeçalho x-tentativas inválido conta como 0 e vai para a retentativa', async () => {
    const { rabbit, consumidor, destinos, canal } = comPublicacao(falha);
    await rabbit.receber(canal, consumidor, entrega({ 'x-tentativas': 'abc' }));
    expect(destinos).toEqual([filaDeRetentativa(FILA)]);
  });

  it('na última tentativa vai para a DLQ, em vez de repetir para sempre', async () => {
    const { rabbit, consumidor, destinos, canal } = comPublicacao(falha);
    await rabbit.receber(canal, consumidor, entrega({ 'x-tentativas': 2 }));
    expect(destinos).toEqual([filaDeMortas(FILA)]);
  });
});
