import { createSigner } from 'fast-jwt';

export const SEGREDO_TESTE = 'segredo-de-teste-com-pelo-menos-32-caracteres';
export const EMISSOR_TESTE = 'fiapx-auth';

export function token(
  claims: { sub: string; email?: string },
  opcoes: { segredo?: string; emissor?: string; expirado?: boolean } = {},
): string {
  const assinar = createSigner({
    key: opcoes.segredo ?? SEGREDO_TESTE,
    iss: opcoes.emissor ?? EMISSOR_TESTE,
    expiresIn: 60_000,
    clockTimestamp: opcoes.expirado ? Date.now() - 120_000 : undefined,
  });
  return assinar({ email: 'ana@fiapx.dev', ...claims });
}
