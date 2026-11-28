import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../../domain/portas/logger';
import type { PublicadorDeMensagens } from './rabbitmq';

interface LinhaDoOutbox {
  id: string;
  routingKey: string;
  payload: unknown;
}

export interface OpcoesDoRelay {
  intervaloMs: number;
  lote: number;
  /** Por quanto tempo manter linhas do outbox já publicadas. */
  retencaoHoras: number;
  /**
   * Por quanto tempo manter a marca de "mensagem consumida" (idempotência).
   * Só precisa cobrir o maior atraso possível de uma reentrega. Depois disso,
   * uma reentrega ainda é inofensiva: a máquina de estados não sai de um status
   * final e o e-mail de falha só sai quando o status muda. Padrão: 7 dias.
   */
  retencaoConsumidasHoras?: number;
}

const UMA_HORA_MS = 60 * 60 * 1000;
const RETENCAO_CONSUMIDAS_PADRAO_HORAS = 7 * 24;

/**
 * A limpeza das consumidas apaga em lotes para não abrir uma transação enorme
 * (nem segurar o ciclo do relay) quando houver muito acúmulo, por exemplo no
 * primeiro deploy desta limpeza. O que sobrar fica para a próxima hora.
 */
const LOTE_LIMPEZA = 5_000;
const MAX_LOTES_POR_LIMPEZA = 20;

/**
 * Publica no RabbitMQ o que foi gravado no outbox. `FOR UPDATE SKIP LOCKED` deixa
 * várias réplicas da API rodarem o relay sem publicar a mesma linha duas vezes.
 */
export class OutboxRelay {
  private temporizador: NodeJS.Timeout | null = null;
  private cicloAtual: Promise<void> | null = null;
  private ultimaLimpeza = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly publicador: PublicadorDeMensagens,
    private readonly logger: Logger,
    private readonly opcoes: OpcoesDoRelay = { intervaloMs: 500, lote: 50, retencaoHoras: 72 },
  ) {}

  iniciar(): void {
    if (this.temporizador) return;
    this.temporizador = setInterval(() => {
      this.cicloAtual ??= this.ciclo().finally(() => {
        this.cicloAtual = null;
      });
    }, this.opcoes.intervaloMs);
  }

  async parar(): Promise<void> {
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
    await this.cicloAtual;
  }

  async ciclo(): Promise<void> {
    try {
      await this.publicarPendentes();
      if (Date.now() - this.ultimaLimpeza > UMA_HORA_MS) await this.limparAntigas();
    } catch (erro) {
      this.logger.error(
        { evento: 'outbox_falhou', erro: erro instanceof Error ? erro.message : String(erro) },
        'falha no ciclo do outbox',
      );
    }
  }

  async publicarPendentes(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const linhas = await tx.$queryRaw<LinhaDoOutbox[]>`
          SELECT id, routing_key AS "routingKey", payload
          FROM outbox
          WHERE publicado_em IS NULL
          ORDER BY criado_em
          LIMIT ${this.opcoes.lote}
          FOR UPDATE SKIP LOCKED`;

        let publicadas = 0;
        for (const linha of linhas) {
          try {
            await this.publicador.publicar(linha.routingKey, linha.payload);
          } catch (erro) {
            await tx.outbox.update({
              where: { id: linha.id },
              data: { tentativas: { increment: 1 } },
            });
            this.logger.warn(
              {
                evento: 'outbox_publicacao_adiada',
                mensagemId: linha.id,
                tipoMensagem: linha.routingKey,
                erro: erro instanceof Error ? erro.message : String(erro),
              },
              'mensagem do outbox não publicada; nova tentativa no próximo ciclo',
            );
            break;
          }
          await tx.outbox.update({ where: { id: linha.id }, data: { publicadoEm: new Date() } });
          publicadas++;
        }
        return publicadas;
      },
      { timeout: 30_000 },
    );
  }

  /** Manutenção de hora em hora: outbox já publicado e marcas de consumo antigas. */
  private async limparAntigas(): Promise<void> {
    this.ultimaLimpeza = Date.now();
    const limite = new Date(Date.now() - this.opcoes.retencaoHoras * UMA_HORA_MS);
    await this.prisma.outbox.deleteMany({ where: { publicadoEm: { lt: limite } } });
    await this.limparConsumidas();
  }

  /**
   * Sem esta limpeza, `mensagens_processadas` ganhava 2 ou 3 linhas por vídeo
   * para sempre. Usa o índice em `processada_em`.
   */
  async limparConsumidas(): Promise<number> {
    const horas = this.opcoes.retencaoConsumidasHoras ?? RETENCAO_CONSUMIDAS_PADRAO_HORAS;
    const limite = new Date(Date.now() - horas * UMA_HORA_MS);

    let total = 0;
    for (let lote = 0; lote < MAX_LOTES_POR_LIMPEZA; lote++) {
      // DELETE com LIMIT não existe no PostgreSQL: o subselect escolhe o lote.
      const apagadas = await this.prisma.$executeRaw`
        DELETE FROM mensagens_processadas
        WHERE (id, consumidor) IN (
          SELECT id, consumidor FROM mensagens_processadas
          WHERE processada_em < ${limite}
          LIMIT ${LOTE_LIMPEZA}
        )`;
      total += apagadas;
      if (apagadas < LOTE_LIMPEZA) break; // acabou o acúmulo
    }
    return total;
  }
}
