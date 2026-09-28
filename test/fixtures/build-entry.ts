// `scripts/build.ts` usa `import.meta.dirname`/`import.meta.main`, que não
// existem sob o transform CJS do ts-jest — por isso este script roda como
// processo Node real (spawn), nunca é importado pelo jest. Único ponto de
// build para os fixtures de teste: pares `nome=arquivo` em argv viram
// `entryPoints` customizados repassados a `build`.
import { build } from '../../scripts/build.ts';

const outdir = process.argv[2];
const pairs = process.argv.slice(3);
if (outdir === undefined || pairs.length === 0) {
  throw new Error('usage: build-entry.ts <outdir> <name>=<file> ...');
}

const entryPoints: Record<string, string> = {};
for (const pair of pairs) {
  const [name, file] = pair.split('=');
  if (name === undefined || file === undefined) {
    throw new Error(`invalid entry "${pair}", expected <name>=<file>`);
  }
  entryPoints[name] = file;
}

await build({ write: true, outdir, entryPoints });
