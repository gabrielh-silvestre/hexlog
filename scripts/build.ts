import * as esbuild from 'esbuild';
import * as path from 'node:path';

// Nunca o cwd: garante o mesmo bytes independente de onde o script é chamado
// (instalador, e2e ou `npm run build`), evitando falso "artefato-desatualizado".
export const raizDoRepo = path.resolve(import.meta.dirname, '..');

export const entradas: Record<string, string> = {
  servidor: 'src/servidor.ts',
  'guarda-bash': 'hook/guarda-bash.ts',
};

interface OpcoesConstruir {
  write: boolean;
  outdir?: string;
  entryPoints?: Record<string, string>;
}

export function construir({
  write,
  outdir = path.join(raizDoRepo, 'dist'),
  entryPoints = entradas,
}: OpcoesConstruir) {
  return esbuild.build({
    absWorkingDir: raizDoRepo,
    entryPoints,
    outdir,
    write,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  });
}

// Ocorrência do shim de `require` dinâmico que o esbuild injeta para uma
// dependência CJS não embutida (só lança quando o caminho é executado).
export const temDynamicRequire = (bytes: Uint8Array): boolean =>
  Buffer.from(bytes).includes('Dynamic require of');

if (import.meta.main) {
  const flagIndex = process.argv.indexOf('--outdir');
  const outdir = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
  await construir({ write: true, ...(outdir ? { outdir } : {}) });
}
