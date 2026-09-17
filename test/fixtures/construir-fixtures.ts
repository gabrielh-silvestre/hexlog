// `scripts/build.ts` usa `import.meta.dirname`/`import.meta.main`, que não
// existem sob o transform CJS do ts-jest — por isso este script roda como
// processo Node real (spawn), nunca é importado pelo jest, e repassa
// `entryPoints` customizados (os fixtures de probe) para `construir`.
import { construir } from '../../scripts/build.ts';

const outdir = process.argv[2];
if (outdir === undefined) {
  throw new Error('uso: construir-fixtures.ts <outdir>');
}

await construir({
  write: true,
  outdir,
  entryPoints: {
    'servidor-probe': 'test/fixtures/servidor-probe.ts',
    'hook-probe': 'test/fixtures/hook-probe.ts',
  },
});
