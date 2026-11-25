export interface AvisoDeFalha {
  destinatario: string;
  nomeArquivo: string;
  motivo: string;
  videoId: string;
}

export interface Notificador {
  avisarFalha(aviso: AvisoDeFalha): Promise<void>;
}
