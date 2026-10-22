import { escapeRegExp } from 'es-toolkit';
import path from 'node:path';
import type { Configuration } from 'lint-staged';

// Regex (para `jest --testPathPatterns`) do spec de cada `.ts` em stage, pelo nome e em qualquer
// pasta de `test/`: `src/adapters/fs/lock.ts` casa `test/adapters/lock.spec.ts` e
// `lock.property.spec.ts`, porque a pasta do spec nem sempre espelha a do código. Spec em stage
// roda a si mesmo; helper e fixture de `test/` não rodam nada.
const namePatterns = (files: readonly string[]): string[] =>
  files.flatMap((file) => {
    const { dir, name, base } = path.parse(path.relative(process.cwd(), file));
    if (dir === 'test' || dir.startsWith('test/')) {
      return base.endsWith('.spec.ts') ? [`${escapeRegExp(`${dir}/${base}`)}$`] : [];
    }
    return [`test/(.*/)?${escapeRegExp(name)}(\\.[^/]*)?\\.spec\\.ts$`];
  });

// Núcleo que todo commit com `.ts` roda (cerca de 5 s): domínio, carregador do log e o `register`.
const CORE_PATTERNS = [
  'test/domain/',
  'test/shared/',
  'test/commands/register(-state)?\\.spec\\.ts$',
];

// Spec sem correspondente não roda nada além do núcleo: o padrão não casa e o jest sai 0
// (`--passWithNoTests`).
const stagedSpecs = (files: readonly string[]): string =>
  `npm test -- --passWithNoTests --testPathPatterns ${[...CORE_PATTERNS, ...namePatterns(files)].map((p) => `'${p}'`).join(' ')}`;

const config = {
  // Dentro da chave `*.ts` a ordem importa: o `tsc` e o jest têm de ler os arquivos já corrigidos
  // por `eslint --fix` e `prettier --write`.
  //
  // As duas chaves (`*.ts` e `*.md`) rodam em série por `--concurrent false` em `.husky/pre-commit`:
  // o arquivo de config não tem essa opção, e o spec de doc lê `src/**/*.ts`, que a outra chave
  // ainda pode estar reescrevendo.
  //
  // Função sem argumento não recebe a lista de arquivos: o `tsc` confere o projeto inteiro, no
  // estado do stash do lint-staged.
  '*.ts': ['eslint --fix', 'prettier --write', () => 'npm run typecheck', stagedSpecs],
  // Os dois linters leem só os `.md` em stage (`ignores` e `ignorePaths` valem para arquivo explícito);
  // `--no-must-find-files` deixa passar o commit só de `docs/pesquisa/**`, que o cspell ignora.
  '*.md': [
    'markdownlint-cli2',
    'cspell --no-progress --no-must-find-files',
    () => 'npm test -- test/directives.spec.ts test/skill-coherence.spec.ts',
  ],
} satisfies Configuration;

export default config;
