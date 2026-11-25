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
  retencaoHoras: number;
}

const UMA_HORA_MS = 60 * 60 * 1000;

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
      if (Date.now() - this.ultimaLimpeza > UMA_HORA_MS) await this.limparPublicadas();
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

  private async limparPublicadas(): Promise<void> {
    this.ultimaLimpeza = Date.now();
    const limite = new Date(Date.now() - this.opcoes.retencaoHoras * UMA_HORA_MS);
    await this.prisma.outbox.deleteMany({ where: { publicadoEm: { lt: limite } } });
  }
}
