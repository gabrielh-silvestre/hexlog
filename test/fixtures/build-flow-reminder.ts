// Mesmo motivo de build-hook.ts: `scripts/build.ts` usa
// `import.meta.dirname`/`import.meta.main`, incompatíveis com o transform CJS
// do ts-jest, então roda como processo Node real (spawn). Constrói só
// `flow-reminder.mjs`, com a config de produção (`build`), para o passo 3.
import { build } from '../../scripts/build.ts';

const outdir = process.argv[2];
if (outdir === undefined) {
  throw new Error('usage: build-flow-reminder.ts <outdir>');
}

await build({
  write: true,
  outdir,
  entryPoints: { 'flow-reminder': 'hook/flow-reminder.ts' },
});
