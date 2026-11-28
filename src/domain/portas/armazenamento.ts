export interface UrlAssinada {
  url: string;
  metodo: 'PUT' | 'GET';
  cabecalhos: Record<string, string>;
  expiraEm: Date;
}

export interface Armazenamento {
  urlDeEnvio(chave: string, contentType: string, tamanhoBytes: number): Promise<UrlAssinada>;
  urlDeDownload(chave: string, nomeParaDownload: string): Promise<UrlAssinada>;
  /** Tamanho do objeto em bytes, ou `null` se ele não existe. */
  tamanho(chave: string): Promise<number | null>;
}
