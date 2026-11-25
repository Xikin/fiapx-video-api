export interface Relogio {
  agora(): Date;
}

export const relogioDoSistema: Relogio = { agora: () => new Date() };

export interface GeradorDeId {
  novo(): string;
}
