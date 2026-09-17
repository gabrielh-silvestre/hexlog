// Mesmo motivo de build-fixtures.ts: `scripts/build.ts` usa
// `import.meta.dirname`/`import.meta.main`, incompatíveis com o transform CJS
// do ts-jest, então roda como processo Node real (spawn). Constrói só
// `bash-guard.mjs`, com a config de produção (`build`), para o B1(b) do
// passo 9.
import { build } from '../../scripts/build.ts';

const outdir = process.argv[2];
if (outdir === undefined) {
  throw new Error('usage: build-hook.ts <outdir>');
}

await build({
  write: true,
  outdir,
  entryPoints: { 'bash-guard': 'hook/bash-guard.ts' },
});
