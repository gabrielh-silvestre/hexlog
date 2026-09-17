// `scripts/build.ts` usa `import.meta.dirname`/`import.meta.main`, que não
// existem sob o transform CJS do ts-jest — por isso este script roda como
// processo Node real (spawn), nunca é importado pelo jest, e repassa
// `entryPoints` customizados (os fixtures de probe) para `build`.
import { build } from '../../scripts/build.ts';

const outdir = process.argv[2];
if (outdir === undefined) {
  throw new Error('usage: build-fixtures.ts <outdir>');
}

await build({
  write: true,
  outdir,
  entryPoints: {
    'server-probe': 'test/fixtures/server-probe.ts',
    'hook-probe': 'test/fixtures/hook-probe.ts',
  },
});
