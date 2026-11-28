import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Armazenamento, UrlAssinada } from '../../domain/portas/armazenamento';

export interface OpcoesS3 {
  bucket: string;
  regiao: string;
  /** Endpoint usado pela API (LocalStack no Compose). Ausente na AWS. */
  endpoint?: string;
  /** Endpoint que aparece nas URLs assinadas entregues ao navegador. */
  endpointPublico?: string;
  forcePathStyle: boolean;
  ttlSegundos: number;
}

/**
 * Upload e download vão direto entre o cliente e o S3 por URL assinada (ADR 0002).
 * A URL de envio amarra `Content-Type` e `Content-Length`: o cliente não consegue
 * mandar outro tipo nem outro tamanho com ela.
 */
export class S3Armazenamento implements Armazenamento {
  private readonly interno: S3Client;
  private readonly publico: S3Client;

  constructor(private readonly opcoes: OpcoesS3) {
    // Sem checksum automático: a URL assinada iria exigir um cabeçalho que o navegador não manda.
    const base = {
      region: opcoes.regiao,
      forcePathStyle: opcoes.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.interno = new S3Client({ ...base, endpoint: opcoes.endpoint });
    this.publico = new S3Client({ ...base, endpoint: opcoes.endpointPublico ?? opcoes.endpoint });
  }

  async urlDeEnvio(chave: string, contentType: string, tamanhoBytes: number): Promise<UrlAssinada> {
    const comando = new PutObjectCommand({
      Bucket: this.opcoes.bucket,
      Key: chave,
      ContentType: contentType,
      ContentLength: tamanhoBytes,
    });
    const url = await getSignedUrl(this.publico, comando, {
      expiresIn: this.opcoes.ttlSegundos,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      metodo: 'PUT',
      cabecalhos: { 'content-type': contentType },
      expiraEm: this.expiracao(),
    };
  }

  async urlDeDownload(chave: string, nomeParaDownload: string): Promise<UrlAssinada> {
    const comando = new GetObjectCommand({
      Bucket: this.opcoes.bucket,
      Key: chave,
      ResponseContentDisposition: `attachment; filename="${nomeParaDownload}"`,
    });
    const url = await getSignedUrl(this.publico, comando, { expiresIn: this.opcoes.ttlSegundos });
    return { url, metodo: 'GET', cabecalhos: {}, expiraEm: this.expiracao() };
  }

  async tamanho(chave: string): Promise<number | null> {
    try {
      const cabecalho = await this.interno.send(
        new HeadObjectCommand({ Bucket: this.opcoes.bucket, Key: chave }),
      );
      return cabecalho.ContentLength ?? 0;
    } catch (erro) {
      if (erro instanceof NotFound) return null;
      if (erro instanceof S3ServiceException && erro.$metadata.httpStatusCode === 404) return null;
      throw erro;
    }
  }

  private expiracao(): Date {
    return new Date(Date.now() + this.opcoes.ttlSegundos * 1000);
  }
}
