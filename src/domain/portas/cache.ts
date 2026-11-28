export interface Cache {
  obter<T>(chave: string): Promise<T | null>;
  definir(chave: string, valor: unknown, ttlSegundos: number): Promise<void>;
  remover(chave: string): Promise<void>;
}

export const cacheDesligado: Cache = {
  obter: async () => null,
  definir: async () => {},
  remover: async () => {},
};

export const chaveListaDoUsuario = (usuarioId: string) => `videos:usuario:${usuarioId}`;
