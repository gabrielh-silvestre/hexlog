// Mesmo motivo de construir-fixtures.ts: `scripts/build.ts` usa
// `import.meta.dirname`/`import.meta.main`, incompatíveis com o transform CJS
// do ts-jest, então roda como processo Node real (spawn). Constrói só
// `guarda-bash.mjs`, com a config de produção (`construir`), para o B1(b) do
// passo 9.
import { construir } from '../../scripts/build.ts';

const outdir = process.argv[2];
if (outdir === undefined) {
  throw new Error('uso: construir-hook.ts <outdir>');
}

await construir({
  write: true,
  outdir,
  entryPoints: { 'guarda-bash': 'hook/guarda-bash.ts' },
});
