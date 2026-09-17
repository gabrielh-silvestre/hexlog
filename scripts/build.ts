import * as esbuild from 'esbuild';
import * as path from 'node:path';

// Nunca o cwd: garante o mesmo bytes independente de onde o script é chamado
// (instalador, e2e ou `npm run build`), evitando falso "artifact-outdated".
export const repoRoot = path.resolve(import.meta.dirname, '..');

export const entries: Record<string, string> = {
  server: 'src/server.ts',
  'bash-guard': 'hook/bash-guard.ts',
};

interface BuildOptions {
  write: boolean;
  outdir?: string;
  entryPoints?: Record<string, string>;
}

export function build({
  write,
  outdir = path.join(repoRoot, 'dist'),
  entryPoints = entries,
}: BuildOptions) {
  return esbuild.build({
    absWorkingDir: repoRoot,
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
export const hasDynamicRequire = (bytes: Uint8Array): boolean =>
  Buffer.from(bytes).includes('Dynamic require of');

if (import.meta.main) {
  const flagIndex = process.argv.indexOf('--outdir');
  const outdir = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
  await build({ write: true, ...(outdir ? { outdir } : {}) });
}
