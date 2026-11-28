import type Redis from 'ioredis';
import type { Cache } from '../../domain/portas/cache';
import type { Logger } from '../../domain/portas/logger';

/** Cache que nunca derruba a requisição: Redis fora do ar vira consulta direta ao banco. */
export class RedisCache implements Cache {
  constructor(
    private readonly redis: Pick<Redis, 'get' | 'set' | 'del'>,
    private readonly logger: Logger,
  ) {}

  async obter<T>(chave: string): Promise<T | null> {
    try {
      const bruto = await this.redis.get(chave);
      return bruto ? (JSON.parse(bruto) as T) : null;
    } catch (erro) {
      this.registrarFalha('obter', chave, erro);
      return null;
    }
  }

  async definir(chave: string, valor: unknown, ttlSegundos: number): Promise<void> {
    try {
      await this.redis.set(chave, JSON.stringify(valor), 'EX', ttlSegundos);
    } catch (erro) {
      this.registrarFalha('definir', chave, erro);
    }
  }

  async remover(chave: string): Promise<void> {
    try {
      await this.redis.del(chave);
    } catch (erro) {
      this.registrarFalha('remover', chave, erro);
    }
  }

  private registrarFalha(operacao: string, chave: string, erro: unknown): void {
    this.logger.warn(
      {
        evento: 'falha_integracao',
        integracao: 'redis',
        operacao,
        chave,
        erro: erro instanceof Error ? erro.message : String(erro),
      },
      'cache indisponível; seguindo direto para o banco',
    );
  }
}
