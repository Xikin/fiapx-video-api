import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import type { Logger } from '../../domain/portas/logger';
import { MensagemInvalidaError } from '../../domain/mensageria/contratos';

export interface PublicadorDeMensagens {
  publicar(routingKey: string, mensagem: unknown): Promise<void>;
}

export interface Consumidor {
  fila: string;
  bindings: string[];
  prefetch?: number;
  tratar(mensagem: unknown): Promise<void>;
}

export interface OpcoesRabbitMQ {
  url: string;
  exchange: string;
  servico: string;
  maxTentativas: number;
  atrasoRetentativaMs: number;
  logger: Logger;
}

export const filaDeRetentativa = (fila: string) => `${fila}.retry`;
export const filaDeMortas = (fila: string) => `${fila}.dlq`;

/**
 * Lê o contador `x-tentativas` do cabeçalho. Qualquer valor que não seja um
 * inteiro >= 0 vale 0: antes, `Number('abc')` dava NaN, `NaN + 1 >= max` nunca
 * era verdade e a mensagem ficava em retentativa para sempre, sem ir para a DLQ.
 */
export function lerTentativa(valor: unknown): number {
  const numero = typeof valor === 'number' ? valor : Number(valor);
  return Number.isSafeInteger(numero) && numero >= 0 ? numero : 0;
}

function conectarComRecuperacao(url: string, setup: (model: ChannelModel) => Promise<void>) {
  return connect(url, {
    recovery: { initialDelay: 500, maxDelay: 15_000, initialMaxRetries: 20, setup },
  });
}

type Conexao = Awaited<ReturnType<typeof conectarComRecuperacao>>;

/**
 * Adaptador do RabbitMQ (ADR 0003):
 * - publicação com confirmação do broker e `mandatory`, para não perder mensagem sem fila;
 * - cada consumidor tem fila principal, fila de retentativa com TTL e fila de mortas;
 * - ack só depois de tratar: se o processo cair, a mensagem volta para a fila.
 */
export class RabbitMQ implements PublicadorDeMensagens {
  private conexao: Conexao | null = null;
  private canalDePublicacao: ConfirmChannel | null = null;
  private readonly consumidores: Consumidor[] = [];
  private readonly devolvidas = new Set<string>();

  constructor(private readonly opcoes: OpcoesRabbitMQ) {}

  registrar(consumidor: Consumidor): void {
    this.consumidores.push(consumidor);
  }

  get conectado(): boolean {
    return this.canalDePublicacao !== null;
  }

  async conectar(): Promise<void> {
    const { logger } = this.opcoes;
    this.conexao = await conectarComRecuperacao(this.opcoes.url, (model) => this.configurar(model));
    this.conexao.on('disconnect', (erro: Error) => {
      this.canalDePublicacao = null;
      logger.warn(
        { evento: 'mensageria_desconectada', erro: erro?.message },
        'RabbitMQ desconectado',
      );
    });
    this.conexao.on('reconnect-failed', (erro: Error) =>
      logger.error(
        { evento: 'mensageria_reconexao_falhou', erro: erro?.message },
        'RabbitMQ: tentativas de reconexão esgotadas',
      ),
    );
  }

  async encerrar(): Promise<void> {
    const conexao = this.conexao;
    this.conexao = null;
    this.canalDePublicacao = null;
    if (conexao) await conexao.close();
  }

  async publicar(routingKey: string, mensagem: unknown): Promise<void> {
    const canal = this.canalDePublicacao;
    if (!canal) throw new Error('RabbitMQ indisponível');

    const corpo = mensagem as { id: string; tipo: string; videoId?: string };
    await new Promise<void>((resolve, reject) => {
      canal.publish(
        this.opcoes.exchange,
        routingKey,
        Buffer.from(JSON.stringify(mensagem)),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId: corpo.id,
          type: corpo.tipo,
          correlationId: corpo.videoId,
          appId: this.opcoes.servico,
          timestamp: Math.floor(Date.now() / 1000),
        },
        (erro) =>
          erro ? reject(erro instanceof Error ? erro : new Error(String(erro))) : resolve(),
      );
    });

    if (this.devolvidas.delete(corpo.id))
      throw new Error(`Nenhuma fila recebe "${routingKey}"; a mensagem será reenviada`);
  }

  private async configurar(model: ChannelModel): Promise<void> {
    const canal = await model.createConfirmChannel();
    canal.on('return', (devolvida: ConsumeMessage) => {
      if (devolvida.properties.messageId) this.devolvidas.add(devolvida.properties.messageId);
    });
    await canal.assertExchange(this.opcoes.exchange, 'topic', { durable: true });

    for (const consumidor of this.consumidores) await this.declararFilas(canal, consumidor);
    this.canalDePublicacao = canal;

    for (const consumidor of this.consumidores) {
      const canalDeConsumo = await model.createChannel();
      await canalDeConsumo.prefetch(consumidor.prefetch ?? 10);
      await canalDeConsumo.consume(consumidor.fila, (entrega) => {
        if (!entrega) return;
        // Última barreira: `receber` já trata os próprios erros, mas uma rejeição
        // que escapasse daqui viraria "unhandled rejection" e derrubaria o processo.
        this.receber(canalDeConsumo, consumidor, entrega).catch((erro: unknown) =>
          this.opcoes.logger.error(
            {
              evento: 'consumo_falhou',
              fila: consumidor.fila,
              erro: erro instanceof Error ? erro.message : String(erro),
            },
            'erro inesperado ao tratar a mensagem',
          ),
        );
      });
    }
  }

  private async declararFilas(canal: Channel, consumidor: Consumidor): Promise<void> {
    await canal.assertQueue(consumidor.fila, { durable: true });
    await canal.assertQueue(filaDeRetentativa(consumidor.fila), {
      durable: true,
      arguments: {
        'x-message-ttl': this.opcoes.atrasoRetentativaMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': consumidor.fila,
      },
    });
    await canal.assertQueue(filaDeMortas(consumidor.fila), { durable: true });
    for (const binding of consumidor.bindings)
      await canal.bindQueue(consumidor.fila, this.opcoes.exchange, binding);
  }

  private async receber(canal: Channel, consumidor: Consumidor, entrega: ConsumeMessage) {
    const { logger } = this.opcoes;
    const cabecalhos = (entrega.properties.headers ?? {}) as Record<string, unknown>;
    const tentativa = lerTentativa(cabecalhos['x-tentativas']);
    const contexto = {
      fila: consumidor.fila,
      mensagemId: String(entrega.properties.messageId ?? ''),
      tipoMensagem: String(entrega.properties.type ?? entrega.fields.routingKey),
      videoId: String(entrega.properties.correlationId ?? ''),
      tentativa,
    };

    // O tratamento fica separado do ack: se o tratamento deu certo e só o ack
    // falhou (canal caiu), isso não é erro da mensagem e ela não deve ir para a
    // retentativa. O broker a reentrega e a idempotência do consumidor absorve.
    let erroDoTratamento: unknown;
    let tratou = false;
    try {
      const corpo: unknown = JSON.parse(entrega.content.toString('utf8'));
      await consumidor.tratar(corpo);
      tratou = true;
    } catch (erro) {
      erroDoTratamento = erro;
    }

    if (tratou) {
      this.confirmar(canal, entrega, contexto);
      return;
    }

    const erro = erroDoTratamento;
    const motivo = erro instanceof Error ? erro.message : String(erro);
    const definitivo = erro instanceof SyntaxError || erro instanceof MensagemInvalidaError;
    const esgotou = tentativa + 1 >= this.opcoes.maxTentativas;
    const destino =
      definitivo || esgotou ? filaDeMortas(consumidor.fila) : filaDeRetentativa(consumidor.fila);

    try {
      await this.reencaminhar(destino, entrega, {
        ...cabecalhos,
        'x-tentativas': tentativa + 1,
        'x-ultimo-erro': motivo.slice(0, 500),
      });
    } catch {
      // Sem como reencaminhar (broker fora do ar): devolve a mensagem para a fila.
      this.devolver(canal, entrega, contexto);
      return;
    }
    // Se este ack falhar, a cópia já está na retentativa/DLQ e o broker ainda
    // reentrega a original: duplicata que a idempotência absorve.
    this.confirmar(canal, entrega, contexto);

    const registro = { evento: 'mensagem_falhou', ...contexto, destino, erro: motivo };
    if (destino === filaDeMortas(consumidor.fila))
      logger.error(registro, 'mensagem enviada para a fila de mortas');
    else logger.warn(registro, 'mensagem agendada para nova tentativa');
  }

  /**
   * `ack` que não lança. Com o canal fechado, a amqplib lança
   * `IllegalOperationError`; nesse caso o broker já considera a mensagem não
   * confirmada e vai reentregá-la, então basta registrar.
   */
  private confirmar(canal: Channel, entrega: ConsumeMessage, contexto: object): void {
    try {
      canal.ack(entrega);
    } catch (erro) {
      this.registrarCanalFechado('ack', contexto, erro);
    }
  }

  /** `nack` com devolução à fila que não lança (mesmo motivo de `confirmar`). */
  private devolver(canal: Channel, entrega: ConsumeMessage, contexto: object): void {
    try {
      canal.nack(entrega, false, true);
    } catch (erro) {
      this.registrarCanalFechado('nack', contexto, erro);
    }
  }

  private registrarCanalFechado(operacao: string, contexto: object, erro: unknown): void {
    this.opcoes.logger.warn(
      {
        evento: 'canal_fechado',
        operacao,
        ...contexto,
        erro: erro instanceof Error ? erro.message : String(erro),
      },
      'canal fechado antes da confirmação; o broker vai reentregar a mensagem',
    );
  }

  private async reencaminhar(
    fila: string,
    entrega: ConsumeMessage,
    cabecalhos: Record<string, unknown>,
  ): Promise<void> {
    const canal = this.canalDePublicacao;
    if (!canal) throw new Error('RabbitMQ indisponível');
    await new Promise<void>((resolve, reject) => {
      canal.sendToQueue(
        fila,
        entrega.content,
        { ...entrega.properties, persistent: true, headers: cabecalhos },
        (erro) =>
          erro ? reject(erro instanceof Error ? erro : new Error(String(erro))) : resolve(),
      );
    });
  }
}
