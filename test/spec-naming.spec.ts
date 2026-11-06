import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { namePatterns } from '../lint-staged.config.ts';
import { at, listFiles } from './helpers.ts';

type Reason = 'entrypoint' | 'internal' | 'no-logic' | 'shared-spec';

// Arquivos de produção sem spec próprio. A regra está em
// `docs/directives/qualidade-e-testes.md`, seção "Convenções dos specs".
const EXCEPTIONS: Readonly<Record<string, Reason>> = {
  // Só compõem e sobem o resto; quem os prova é o e2e sobre o artefato.
  'scripts/build.ts': 'entrypoint',
  'src/mcp/server.ts': 'entrypoint',
  'src/server.ts': 'entrypoint',

  // `mark.ts`, `flow.ts`: `flow-scripts.spec.ts`. `marker.ts` e `flow-command.ts`: lá só o teste de
  // imports; a lógica passa por `flow-hooks.spec.ts`. `mark.ts` e `marker.ts` são o marcador do
  // gate de PR, e o pré-commit não roda esses specs ao editá-los.
  '.claude/hooks/flow-command.ts': 'shared-spec',
  'scripts/flow/flow.ts': 'shared-spec',
  'scripts/flow/mark.ts': 'shared-spec',
  'scripts/flow/marker.ts': 'shared-spec',
  // Coberto por `release-notes.spec.ts`, junto da biblioteca que chama.
  'scripts/release-notes-cli.ts': 'shared-spec',

  // Peças internas de um serviço, provadas pelo spec dele.
  'src/adapters/fs/io.ts': 'internal',
  'src/adapters/telemetry/within.ts': 'internal',
  'src/commands/register/attachments.ts': 'internal',
  'src/commands/register/state.ts': 'internal',
  'src/commands/register/static.ts': 'internal',
  'src/queries/read.ts': 'internal',
  'src/shared/latest.ts': 'internal',
  // Adaptadores de tool: a prova é a integração de `test/mcp/`, não o spec do serviço de mesmo nome.
  'src/mcp/tools/attachment.ts': 'internal',
  'src/mcp/tools/definition.ts': 'internal',
  'src/mcp/tools/process.ts': 'internal',

  'src/domain/manifest.ts': 'no-logic',
  'src/ports.ts': 'no-logic',
  'src/shared/logger.ts': 'no-logic',
  'src/version.ts': 'no-logic',
};

const repoRoot = path.resolve(__dirname, '..');
const filesIn = (dir: string, extension: string, ignored?: ReadonlySet<string>): string[] =>
  listFiles(path.join(repoRoot, dir), extension, ignored).map((file) =>
    path.relative(repoRoot, file),
  );

const production = ['src', 'scripts', 'hook', '.claude/hooks'].flatMap((dir) =>
  filesIn(dir, '.ts'),
);
const specs = filesIn('test', '.spec.ts', new Set(['fixtures']));

const isRepeated = (file: string): boolean =>
  production.filter((other) => path.basename(other) === path.basename(file)).length > 1;

// O nome casa pelo mesmo padrão do pré-commit. Em nome repetido na produção, só conta o spec que
// cita o caminho do arquivo.
// shortcut: nome único só confere o nome, então `src/mcp/tools/query.ts` também casa
// `test/queries/query.spec.ts`, que prova o serviço, e `foo.e2e.spec.ts` passa por unitário de
// `foo.ts`; conferir o que o spec exercita pede analisar cada um.
const ownSpecs = (file: string): string[] => {
  const pattern = new RegExp(at(namePatterns([file]), 0));
  const named = specs.filter((spec) => pattern.test(spec));
  return isRepeated(file)
    ? named.filter((spec) => fs.readFileSync(path.join(repoRoot, spec), 'utf8').includes(file))
    : named;
};

describe('{src,scripts,hook,.claude/hooks}/**/*.ts', () => {
  it('should find a spec of the same name for every production file outside the exceptions', () => {
    const missing = production.filter(
      (file) => !Object.hasOwn(EXCEPTIONS, file) && ownSpecs(file).length === 0,
    );

    expect(missing).toEqual([]);
  });

  it('should keep no exception for a missing file or for a file with a spec of its own', () => {
    const stale = Object.keys(EXCEPTIONS).filter(
      (file) => !production.includes(file) || ownSpecs(file).length > 0,
    );

    expect(stale).toEqual([]);
  });

  it('should not count a spec that only shares the name of a repeated production file', () => {
    expect(ownSpecs('src/mcp/tools/process.ts')).toEqual([]);
  });

  it('should count the spec that cites the path of a repeated production file', () => {
    expect(ownSpecs('src/commands/process.ts')).toEqual(['test/commands/process.spec.ts']);
  });
});
