import { describe, expect, it } from 'vitest';
import {
  MensagemInvalidaError,
  TIPOS,
  lerResultadoDoWorker,
  videoEnviadoSchema,
} from '../../src/domain/mensageria/contratos';
import { falhou, iniciado, processado } from '../support/mensagens';

const VIDEO_ID = '11111111-1111-4111-8111-111111111111';

describe('contratos de mensagens', () => {
  it.each([iniciado(VIDEO_ID), processado(VIDEO_ID), falhou(VIDEO_ID)])(
    'aceita $tipo dentro do contrato',
    (mensagem) => {
      expect(lerResultadoDoWorker(mensagem).tipo).toBe(mensagem.tipo);
    },
  );

  it('recusa tipo desconhecido como mensagem inválida, que vai direto para a DLQ', () => {
    expect(() => lerResultadoDoWorker({ ...iniciado(VIDEO_ID), tipo: 'video.outro' })).toThrow(
      MensagemInvalidaError,
    );
  });

  it('aponta o campo errado na mensagem de erro', () => {
    const errada = processado(VIDEO_ID);
    (errada.dados as { totalFrames: unknown }).totalFrames = -1;
    expect(() => lerResultadoDoWorker(errada)).toThrow(/dados\.totalFrames/);
  });

  it('recusa versão diferente de 1', () => {
    expect(() => lerResultadoDoWorker({ ...falhou(VIDEO_ID), versao: 2 })).toThrow(
      MensagemInvalidaError,
    );
  });

  it('o evento video.enviado exige os dados que o worker usa', () => {
    const resultado = videoEnviadoSchema.safeParse({
      ...iniciado(VIDEO_ID),
      tipo: TIPOS.ENVIADO,
      dados: { usuarioId: 'u', chaveVideo: 'k', nomeArquivo: 'a.mp4', contentType: 'video/mp4' },
    });
    expect(resultado.success).toBe(false);
  });
});
