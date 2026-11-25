import { describe, expect, it } from 'vitest';
import {
  STATUS_VIDEO,
  Video,
  chaveDoVideo,
  sanitizarNomeArquivo,
} from '../../src/domain/videos/video';
import { ConflictError } from '../../src/shared/errors';
import { AGORA, USUARIO, novoVideo } from '../support/fakes';

const depois = new Date(AGORA.getTime() + 60_000);

describe('Video', () => {
  it('nasce aguardando envio, com a chave do S3 sob a pasta do usuário', () => {
    const video = novoVideo();
    expect(video.status).toBe(STATUS_VIDEO.AGUARDANDO_ENVIO);
    expect(video.chaveVideo).toBe(`videos/${USUARIO.id}/${video.id}/aula-1.mp4`);
    expect(video.pertenceA(USUARIO.id)).toBe(true);
    expect(video.pertenceA('outro')).toBe(false);
  });

  it('percorre o caminho feliz até CONCLUIDO', () => {
    const video = novoVideo();
    video.confirmarEnvio(depois);
    expect(video.status).toBe(STATUS_VIDEO.NA_FILA);
    expect(video.iniciarProcessamento(depois)).toBe(true);
    expect(video.concluir({ chaveZip: 'zips/a.zip', totalFrames: 10 }, depois)).toBe(true);
    expect(video.paraDados()).toMatchObject({
      status: STATUS_VIDEO.CONCLUIDO,
      chaveZip: 'zips/a.zip',
      totalFrames: 10,
      atualizadoEm: depois,
    });
    expect(video.finalizado).toBe(true);
  });

  it('não confirma o envio duas vezes', () => {
    const video = novoVideo();
    video.confirmarEnvio(depois);
    expect(() => video.confirmarEnvio(depois)).toThrow(ConflictError);
  });

  it('aceita "processado" sem ter recebido "iniciado" (mensagens fora de ordem)', () => {
    const video = novoVideo();
    video.confirmarEnvio(depois);
    expect(video.concluir({ chaveZip: 'z', totalFrames: 1 }, depois)).toBe(true);
    expect(video.iniciarProcessamento(depois)).toBe(false);
    expect(video.status).toBe(STATUS_VIDEO.CONCLUIDO);
  });

  it('não conclui um vídeo que ainda não foi enviado', () => {
    expect(novoVideo().concluir({ chaveZip: 'z', totalFrames: 1 }, depois)).toBe(false);
  });

  it('um estado final não é desfeito', () => {
    const video = novoVideo();
    video.confirmarEnvio(depois);
    expect(video.falhar('x'.repeat(600), depois)).toBe(true);
    expect(video.paraDados().motivoFalha).toHaveLength(500);
    expect(video.falhar('de novo', depois)).toBe(false);
    expect(video.concluir({ chaveZip: 'z', totalFrames: 1 }, depois)).toBe(false);
    expect(video.status).toBe(STATUS_VIDEO.FALHOU);
  });

  it('restaurar devolve uma cópia independente', () => {
    const dados = novoVideo().paraDados();
    const video = Video.restaurar(dados);
    video.confirmarEnvio(depois);
    expect(dados.status).toBe(STATUS_VIDEO.AGUARDANDO_ENVIO);
  });
});

describe('sanitizarNomeArquivo', () => {
  it.each([
    ['Férias na praia.mp4', 'Ferias-na-praia.mp4'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\videos\\aula.mov', 'aula.mov'],
    ['.oculto.mp4', 'oculto.mp4'],
    ['"><script>.mp4', 'script-.mp4'],
    ['', 'video'],
    ['///', 'video'],
  ])('%s → %s', (entrada, esperado) => {
    expect(sanitizarNomeArquivo(entrada)).toBe(esperado);
  });

  it('limita o tamanho a 120 caracteres', () => {
    expect(sanitizarNomeArquivo(`${'a'.repeat(300)}.mp4`)).toHaveLength(120);
  });

  it('monta a chave a partir do nome limpo', () => {
    expect(chaveDoVideo('u', 'v', 'a b.mp4')).toBe('videos/u/v/a-b.mp4');
  });
});
