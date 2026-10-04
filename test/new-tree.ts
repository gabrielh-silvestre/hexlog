import * as fs from 'node:fs';
import * as path from 'node:path';

export const repoRoot = path.resolve(__dirname, '..');
export const srcRoot = path.join(repoRoot, 'src');

// Sempre ancorado em `src/` da raiz: as fixtures de test/fixtures/boundaries/src espelham nomes de camada.
export const NEW_TREE_DIRS = ['domain', 'shared', 'commands', 'queries', 'adapters', 'mcp'].map(
  (layer) => path.join(srcRoot, layer),
);
const NEW_TREE_ROOT_FILES = ['compose.ts', 'archive.ts'].map((name) => path.join(srcRoot, name));

/**
 * Arquivos que a árvore nova já tem; os specs que a varrem conferem que `listNewTreeFiles` os acha,
 * senão um âncora ou um filtro quebrado os faria passar sem olhar arquivo nenhum.
 */
export const NEW_TREE_KNOWN_FILES = ['domain/chain.ts', 'domain/gate.ts', 'domain/ids.ts'];

/** Arquivos .ts da árvore nova que já existem; pastas e arquivos ausentes são pulados. */
export function listNewTreeFiles(extraFiles: string[] = []): string[] {
  const inDirs = NEW_TREE_DIRS.filter((dir) => fs.existsSync(dir)).flatMap((dir) =>
    fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => path.join(dir, entry)),
  );
  const single = [...NEW_TREE_ROOT_FILES, ...extraFiles].filter((file) => fs.existsSync(file));
  return [...inDirs, ...single];
}
