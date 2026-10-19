import { escapeRegExp } from 'es-toolkit';
import path from 'node:path';
import type { Configuration } from 'lint-staged';

// Regex (para `jest --testPathPatterns`) do spec espelho de cada `.ts` em stage: `src/x/y.ts` casa
// `test/x/y.spec.ts` e `test/x/y.property.spec.ts`; fora de `src/` o espelho fica na raiz de
// `test/` (`hook/y.ts`, `scripts/y.ts` e `.claude/hooks/y.ts` casam `test/y*.spec.ts`). Spec em
// stage roda a si mesmo; helper e fixture de `test/` não rodam nada.
const mirrorPatterns = (files: readonly string[]): string[] =>
  files.flatMap((file) => {
    const { dir, name, base } = path.parse(path.relative(process.cwd(), file));
    if (dir === 'test' || dir.startsWith('test/')) {
      return base.endsWith('.spec.ts') ? [`${escapeRegExp(`${dir}/${base}`)}$`] : [];
    }
    const mirrorDir = dir.startsWith('src/') ? `${dir.slice('src/'.length)}/` : '';
    return [`test/${escapeRegExp(mirrorDir)}${escapeRegExp(name)}(\\.[^/]*)?\\.spec\\.ts$`];
  });

// Spec sem espelho não roda nada: o padrão não casa e o jest sai 0 (`--passWithNoTests`).
const mirrorSpecs = (files: readonly string[]): string[] => {
  const patterns = mirrorPatterns(files);
  return patterns.length === 0
    ? []
    : [
        `npm test -- --passWithNoTests --testPathPatterns ${patterns.map((p) => `'${p}'`).join(' ')}`,
      ];
};

const config = {
  // Uma chave só: chaves diferentes rodam em paralelo, e o `tsc` e o jest têm de ler os arquivos já
  // corrigidos por `eslint --fix` e `prettier --write`. Função sem argumento não recebe a lista de
  // arquivos: o `tsc` confere o projeto inteiro, no estado do stash do lint-staged.
  '*.ts': ['eslint --fix', 'prettier --write', () => 'npm run typecheck', mirrorSpecs],
  '*.md': () => 'npm test -- test/directives.spec.ts test/skill-coherence.spec.ts',
} satisfies Configuration;

export default config;
