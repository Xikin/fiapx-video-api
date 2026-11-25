import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { S3Armazenamento } from '../../../src/infrastructure/armazenamento/s3-armazenamento';
import { IMAGENS } from '../../support/containers';

const BUCKET = 'fiapx-videos-teste';
let container: StartedLocalStackContainer;
let s3: S3Armazenamento;

beforeAll(async () => {
  container = await new LocalstackContainer(IMAGENS.localstack)
    .withEnvironment({ SERVICES: 's3', S3_SKIP_SIGNATURE_VALIDATION: '0' })
    .start();
  const endpoint = container.getConnectionUri();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  await new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true }).send(
    new CreateBucketCommand({ Bucket: BUCKET }),
  );
  s3 = new S3Armazenamento({
    bucket: BUCKET,
    regiao: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    ttlSegundos: 60,
  });
});

afterAll(async () => {
  await container?.stop();
});

describe('S3Armazenamento (LocalStack)', () => {
  it('o cliente envia pela URL assinada e a API enxerga o tamanho', async () => {
    const conteudo = Buffer.from('frames de teste');
    const envio = await s3.urlDeEnvio('videos/u/v/a.mp4', 'video/mp4', conteudo.length);
    expect(envio.expiraEm.getTime()).toBeGreaterThan(Date.now());
    expect(new URL(envio.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );

    const res = await fetch(envio.url, {
      method: 'PUT',
      headers: envio.cabecalhos,
      body: conteudo,
    });
    expect(res.status).toBe(200);
    expect(await s3.tamanho('videos/u/v/a.mp4')).toBe(conteudo.length);
  });

  it('a URL de envio só aceita o tamanho declarado', async () => {
    const envio = await s3.urlDeEnvio('videos/u/v/b.mp4', 'video/mp4', 5);
    const res = await fetch(envio.url, {
      method: 'PUT',
      headers: envio.cabecalhos,
      body: Buffer.alloc(50),
    });
    expect(res.ok).toBe(false);
    expect(await s3.tamanho('videos/u/v/b.mp4')).toBeNull();
  });

  it('a URL de download devolve o arquivo com nome amigável', async () => {
    const envio = await s3.urlDeEnvio('zips/v.zip', 'video/mp4', 3);
    await fetch(envio.url, { method: 'PUT', headers: envio.cabecalhos, body: Buffer.from('zip') });

    const download = await s3.urlDeDownload('zips/v.zip', 'aula-frames.zip');
    const res = await fetch(download.url);
    expect(await res.text()).toBe('zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="aula-frames.zip"');
  });

  it('objeto inexistente tem tamanho null', async () => {
    expect(await s3.tamanho('nao/existe.mp4')).toBeNull();
  });

  it('erro que não é 404 sobe para o chamador', async () => {
    const semBucket = new S3Armazenamento({
      bucket: 'bucket-que-nao-existe',
      regiao: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      forcePathStyle: true,
      ttlSegundos: 60,
    });
    await expect(semBucket.tamanho('x')).rejects.toThrow();
  });
});
