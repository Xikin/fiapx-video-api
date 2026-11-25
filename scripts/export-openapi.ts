/** Exporta o contrato OpenAPI para docs/openapi.json sem subir banco nem broker. */
import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/app';

async function exportar() {
  const app = await buildApp({
    casos: {} as never,
    jwt: { segredo: 'x'.repeat(32), emissor: 'fiapx-auth' },
    swagger: true,
  });
  await app.ready();
  writeFileSync('docs/openapi.json', `${JSON.stringify(app.swagger(), null, 2)}\n`);
  await app.close();
  console.log('docs/openapi.json atualizado');
}

void exportar();
