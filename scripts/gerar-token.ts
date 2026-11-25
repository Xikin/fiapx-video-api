/**
 * Gera um JWT para testar a API localmente enquanto o fiapx-auth-lambda não está no ar.
 *   npx tsx scripts/gerar-token.ts ana@fiapx.dev
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createSigner } from 'fast-jwt';

const email = process.argv[2] ?? 'demo@fiapx.dev';
const segredo = process.env.JWT_SECRET;
if (!segredo || segredo.length < 32) {
  console.error('Defina JWT_SECRET (32+ caracteres) no .env');
  process.exit(1);
}

const sub = createHash('sha256').update(email).digest('hex').slice(0, 24);
const assinar = createSigner({
  key: segredo,
  iss: process.env.JWT_ISSUER ?? 'fiapx-auth',
  expiresIn: 8 * 3600_000,
});
console.log(assinar({ sub, email }));
