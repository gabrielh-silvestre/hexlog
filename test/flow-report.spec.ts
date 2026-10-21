import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import type { QueryResult } from '../src/queries/query-service.ts';
import { at, copyToXdg, createTempDir } from './helpers.ts';
import { type Environment, createEnvironment } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

describe('scripts/flow/report.ts', () => {
  const reportPath = path.join(repoRoot, 'scripts/flow/report.ts');
  const hexlogDir = path.join(repoRoot, '.hexlog');
  const PROJECT = 'hexlog';
  const AGENT = 'flow-report-spec';
  const BATCH_LIMIT = 50;

  type Item = {
    type: string;
    target: string;
    data: Record<string, unknown>;
    alias?: string;
    relations?: Record<string, unknown>[];
  };

  const rests = (to: string) => ({ kind: 'derivesFrom', as: 'rests-on', to });
  const anchoredIn = (to: string) => ({ kind: 'derivesFrom', as: 'anchored-in', to });

  const premise = (proc: string, short: string): Item => ({
    type: 'premise',
    target: `${proc}.premise.${short}`,
    data: { statement: `Premise ${short}` },
  });

  const decision = (proc: string, short: string, relations: Record<string, unknown>[]): Item => ({
    type: 'decision',
    target: `${proc}.decision.${short}`,
    data: {
      choice: `Choice ${short}`,
      alternatives: [{ option: 'Other', reason: 'Not needed' }],
      rationale: 'Because',
      grounds: 'directive',
      confidence: 'high',
    },
    relations,
  });

  /** Define os tipos e as relações de `.hexlog/` no projeto, como `flow-definitions.spec.ts`. */
  async function defineFlow(environment: Environment): Promise<void> {
    const bodyOf = (kind: string, file: string) =>
      JSON.parse(fs.readFileSync(path.join(hexlogDir, kind, file), 'utf8')) as Record<
        string,
        unknown
      >;
    for (const file of fs.readdirSync(path.join(hexlogDir, 'types'))) {
      const name = file.replace(/\.json$/, '');
      await environment.ok('define_type', {
        project: PROJECT,
        name,
        schema: bodyOf('types', file),
      });
    }
    for (const file of fs.readdirSync(path.join(hexlogDir, 'relations'))) {
      const name = file.replace(/\.json$/, '');
      await environment.ok('define_relation', {
        project: PROJECT,
        name,
        ...bodyOf('relations', file),
      });
    }
  }

  /** Grava `items` em lotes de até `BATCH_LIMIT` e devolve os ids na ordem. */
  async function registerItems(
    environment: Environment,
    proc: string,
    items: Item[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let start = 0; start < items.length; start += BATCH_LIMIT) {
      const { records } = await environment.ok<RegisterResult>('register', {
        project: PROJECT,
        process: proc,
        agent: AGENT,
        records: items.slice(start, start + BATCH_LIMIT),
      });
      ids.push(...records.map((record) => record.id));
    }
    return ids;
  }

  /** Um lote só: a chave de cada item é o alias que as relações do lote citam como `@chave`. */
  async function registerNamed(
    environment: Environment,
    proc: string,
    items: Record<string, Item>,
  ): Promise<Record<string, string>> {
    const entries = Object.entries(items);
    const ids = await registerItems(
      environment,
      proc,
      entries.map(([alias, item]) => ({ ...item, alias })),
    );
    return Object.fromEntries(entries.map(([name], index) => [name, at(ids, index)]));
  }

  /** Objetivo, `premises` premissas `p00`, `p01`... e `decisions` decisões `d0`... que citam só o objetivo. */
  async function registerObjectiveFixture(
    environment: Environment,
    proc: string,
    { premises, decisions }: { premises: number; decisions: number },
  ): Promise<void> {
    const shorts = Array.from({ length: premises }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const ids = await registerItems(environment, proc, [
      premise(proc, 'objective'),
      ...shorts.map((short) => premise(proc, short)),
    ]);
    const objective = at(ids, 0);
    await registerItems(
      environment,
      proc,
      Array.from({ length: decisions }, (_, index) =>
        decision(proc, `d${index}`, [rests(objective)]),
      ),
    );
  }

  let xdg: string;
  let xdgWithoutDirectives: string;
  let gitRepo: string;
  let ids: Record<string, string>;
  let inheritedIds: Record<string, string>;
  let currentIds: Set<string>;

  const idOf = (name: string): string => {
    const id = ids[name];
    if (id === undefined) throw new Error(`no fixture id "${name}"`);
    return id;
  };

  beforeAll(async () => {
    const environment = await createEnvironment();
    await defineFlow(environment);
    for (const proc of [
      'directives-9',
      'feat-r',
      'feat-clean',
      'feat-many',
      'feat-wide',
      'feat-edge-lines',
      'feat-edge-wide',
      'feat-inherit',
    ]) {
      await environment.ok('create_process', { project: PROJECT, process: proc });
    }
    const { hash: source } = await environment.ok<{ hash: string }>('attach', {
      project: PROJECT,
      text: 'rule text',
    });
    // `directives-9` (e não o `directives-N` real) prova que o relatório lê o processo pelo prefixo do id.
    const directives = await registerNamed(environment, 'directives-9', {
      r1: {
        type: 'directive',
        target: 'directives.convencoes.r1',
        data: { rule: 'Rule one', section: 'Section', source },
      },
      r2: {
        type: 'directive',
        target: 'directives.fluxo-hexlog.r2',
        data: { rule: 'Rule two', section: 'Section', source },
      },
      none: {
        type: 'premise',
        target: 'directives.estrategia.none',
        data: { statement: 'No premise applies' },
      },
    });
    const directive = (name: string): string => directives[name] ?? '';

    ids = await registerNamed(environment, 'feat-r', {
      objective: premise('feat-r', 'objective'),
      alpha: premise('feat-r', 'alpha'),
      beta: premise('feat-r', 'beta'),
      gamma: premise('feat-r', 'gamma'),
      'd-obj': decision('feat-r', 'd-obj', [rests('@objective')]),
      'd-none': decision('feat-r', 'd-none', [rests(directive('none'))]),
      'd-both-none': decision('feat-r', 'd-both-none', [
        rests('@objective'),
        rests(directive('none')),
      ]),
      'd-revoked-prem': decision('feat-r', 'd-revoked-prem', [
        rests('@objective'),
        rests('@gamma'),
      ]),
      'd-ok': decision('feat-r', 'd-ok', [rests('@alpha')]),
      'd-doc': decision('feat-r', 'd-doc', [anchoredIn(directive('r1')), rests('@alpha')]),
      'd-far': decision('feat-r', 'd-far', [anchoredIn(directive('r2')), rests('@beta')]),
      'd-both': decision('feat-r', 'd-both', [anchoredIn(directive('r1')), rests('@objective')]),
      'd-no-rest': decision('feat-r', 'd-no-rest', []),
      'd-old': decision('feat-r', 'd-old', [rests('@objective')]),
      // `supersedes` exige o mesmo target do antecessor
      'd-new': {
        ...decision('feat-r', 'd-new', [{ kind: 'supersedes', to: '@d-old' }, rests('@alpha')]),
        target: 'feat-r.decision.d-old',
      },
      'd-rev': decision('feat-r', 'd-rev', [rests('@objective')]),
      'd-a': decision('feat-r', 'd-a', [rests('@objective')]),
      'd-b': {
        ...decision('feat-r', 'd-b', [{ kind: 'supersedes', to: '@d-a' }, rests('@alpha')]),
        target: 'feat-r.decision.d-a',
      },
      // revoga `d-rev` e o superseder `d-b`: nem `d-a` nem `d-b` voltam a valer
      revoker: {
        type: 'gap',
        target: 'feat-r.gap.revoker',
        data: { question: 'Why revoke?', context: 'Fixture' },
        relations: [
          { kind: 'revokes', to: '@d-rev' },
          { kind: 'revokes', to: '@d-b' },
        ],
      },
      // revoga a premissa `gamma`, que `d-revoked-prem` ainda cita
      'revoker-prem': {
        type: 'gap',
        target: 'feat-r.gap.revoker-prem',
        data: { question: 'Why revoke the premise?', context: 'Fixture' },
        relations: [{ kind: 'revokes', to: '@gamma' }],
      },
    });

    const clean = await registerNamed(environment, 'feat-clean', {
      objective: premise('feat-clean', 'objective'),
      alpha: premise('feat-clean', 'alpha'),
    });
    await registerItems(environment, 'feat-clean', [
      decision('feat-clean', 'd-ok', [rests(clean.alpha ?? '')]),
    ]);

    // `d-new` não regrava o `rests-on` de `d-old`: o apoio só chega pela herança da linhagem
    inheritedIds = await registerNamed(environment, 'feat-inherit', {
      objective: premise('feat-inherit', 'objective'),
      alpha: premise('feat-inherit', 'alpha'),
      'd-old': decision('feat-inherit', 'd-old', [rests('@objective')]),
      'd-new': decision('feat-inherit', 'd-old', [{ kind: 'supersedes', to: '@d-old' }]),
    });

    await registerObjectiveFixture(environment, 'feat-many', { premises: 0, decisions: 101 });
    await registerObjectiveFixture(environment, 'feat-wide', { premises: 12, decisions: 1 });
    // as bordas: 100 linhas e 10 premissas cabem inteiras, sem corte
    await registerObjectiveFixture(environment, 'feat-edge-lines', { premises: 0, decisions: 100 });
    await registerObjectiveFixture(environment, 'feat-edge-wide', { premises: 10, decisions: 1 });

    const { records: currentDecisions } = await environment.ok<QueryResult>('query', {
      project: PROJECT,
      process: 'feat-r',
      type: 'decision',
      limit: 200,
    });
    currentIds = new Set(currentDecisions.map((record) => record.id));

    xdg = copyToXdg(environment.dataDir);
    xdgWithoutDirectives = copyToXdg(environment.dataDir);
    fs.rmSync(
      processPaths(path.join(xdgWithoutDirectives, 'hexlog'), {
        project: PROJECT,
        process: 'directives-9',
      }).dir,
      { recursive: true },
    );
    await environment.close();

    // main com dois docs; `feat/r` altera só `convencoes.md`; a base `origin/develop` é criada à mão
    gitRepo = createTempDir('flow-report-git');
    git(gitRepo, 'init', '-q', '-b', 'main');
    git(gitRepo, 'config', 'user.email', 'test@example.com');
    git(gitRepo, 'config', 'user.name', 'Test');
    fs.mkdirSync(path.join(gitRepo, 'docs/directives'), { recursive: true });
    for (const doc of ['convencoes', 'fluxo-hexlog']) {
      fs.writeFileSync(path.join(gitRepo, `docs/directives/${doc}.md`), `# ${doc}\n`);
    }
    git(gitRepo, 'add', '.');
    git(gitRepo, 'commit', '-q', '-m', 'docs');
    git(gitRepo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(gitRepo, 'checkout', '-q', '-b', 'feat/r');
    fs.appendFileSync(path.join(gitRepo, 'docs/directives/convencoes.md'), 'amended\n');
    git(gitRepo, 'commit', '-q', '-am', 'amend convencoes');
    // a base avança com `fluxo-hexlog.md` depois de `feat/r` sair: só o diff contra o merge-base o ignora
    git(gitRepo, 'checkout', '-q', 'main');
    fs.appendFileSync(path.join(gitRepo, 'docs/directives/fluxo-hexlog.md'), 'amended on base\n');
    git(gitRepo, 'commit', '-q', '-am', 'amend fluxo-hexlog on base');
    git(gitRepo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(gitRepo, 'checkout', '-q', 'feat/r');
  }, 60_000);

  function runReport(args: string[], options: { xdg?: string } = {}): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [reportPath, ...args], {
      cwd: gitRepo,
      encoding: 'utf8',
      env: { ...process.env, XDG_DATA_HOME: options.xdg ?? xdg },
    });
  }

  /** Colunas por TAB de cada linha impressa. */
  const rowsOf = (result: SpawnSyncReturns<string>): string[][] =>
    result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('\t'));

  const rowFor = (result: SpawnSyncReturns<string>, name: string): string[] | undefined =>
    rowsOf(result).find(([id]) => id === idOf(name));

  const printedIds = (result: SpawnSyncReturns<string>): string[] =>
    rowsOf(result).map(([id]) => id ?? '');

  const OBJECTIVE_UNCITED = 'only-objective: uncited=feat-r.premise.alpha,feat-r.premise.beta';
  const DOC_AMENDED = 'doc-amended: docs/directives/convencoes.md (directives.convencoes.r1)';

  describe('with feat-r against the default base', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      result = runReport(['feat-r']);
    }, 30_000);

    it('should exit with status 0 and no warning on stderr', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/flow-report:/);
    });

    it('should flag the decision that cites only the objective premise, with the uncited premises', () => {
      expect(rowFor(result, 'd-obj')).toEqual([
        idOf('d-obj'),
        'feat-r.decision.d-obj',
        OBJECTIVE_UNCITED,
      ]);
    });

    it('should flag the decision that cites only the sentinel, with the uncited premises', () => {
      expect(rowFor(result, 'd-none')).toEqual([
        idOf('d-none'),
        'feat-r.decision.d-none',
        'only-sentinel: uncited=feat-r.premise.objective,feat-r.premise.alpha,feat-r.premise.beta',
      ]);
    });

    it('should flag the decision that cites the objective and the sentinel together', () => {
      expect(rowFor(result, 'd-both-none')).toEqual([
        idOf('d-both-none'),
        'feat-r.decision.d-both-none',
        OBJECTIVE_UNCITED.replace('only-objective:', 'only-objective+sentinel:'),
      ]);
    });

    it('should count a revoked premise as a citation, so the decision is not flagged', () => {
      expect(rowFor(result, 'd-revoked-prem')).toBeUndefined();
    });

    it('should not flag the decision that cites a delivery premise', () => {
      expect(rowFor(result, 'd-ok')).toBeUndefined();
    });

    it('should not flag the decision without any rests-on', () => {
      expect(rowFor(result, 'd-no-rest')).toBeUndefined();
    });

    it('should flag as doc-amended the decision anchored in a doc changed in the diff', () => {
      expect(rowFor(result, 'd-doc')).toEqual([
        idOf('d-doc'),
        'feat-r.decision.d-doc',
        DOC_AMENDED,
      ]);
    });

    it('should not flag the decision anchored in a doc changed only on the base after the merge-base', () => {
      expect(rowFor(result, 'd-far')).toBeUndefined();
    });

    it('should join both reasons on the same line, separated by "; "', () => {
      expect(rowFor(result, 'd-both')).toEqual([
        idOf('d-both'),
        'feat-r.decision.d-both',
        `${OBJECTIVE_UNCITED}; ${DOC_AMENDED}`,
      ]);
    });

    it.each(['d-old', 'd-rev', 'd-a', 'd-b'])(
      'should not flag %s, which is not current',
      (name) => {
        expect(rowFor(result, name)).toBeUndefined();
      },
    );

    it('should not flag d-new, which is current and cites a delivery premise', () => {
      expect(rowFor(result, 'd-new')).toBeUndefined();
    });

    it('should print only ids that the server query reports as current', () => {
      const printed = printedIds(result);

      expect(printed.length).toBeGreaterThan(0);

      for (const id of printed) expect(currentIds).toContain(id);
    });
  });

  describe('when the foreign process read fails', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      result = runReport(['feat-r'], { xdg: xdgWithoutDirectives });
    }, 30_000);

    it('should exit with status 0 and one warning per prefix, not per id', () => {
      expect(result.status).toBe(0);
      expect(result.stderr.match(/flow-report:/g)).toHaveLength(1);
      expect(result.stderr).toContain('PROCESS_NOT_FOUND');
    });

    it('should keep the only-objective, which does not depend on the foreign process', () => {
      expect(rowFor(result, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
    });

    it('should not wrongly flag the sentinel citation nor doc-amended without a target', () => {
      expect(rowFor(result, 'd-none')).toBeUndefined();
      expect(rowFor(result, 'd-doc')).toBeUndefined();
    });
  });

  it('should drop doc-amended when the base is swapped for feat/r and the diff is empty', () => {
    const result = runReport(['feat-r', 'feat/r']);

    expect(result.status).toBe(0);
    expect(rowFor(result, 'd-doc')).toBeUndefined();
    expect(rowFor(result, 'd-both')?.[2]).toBe(OBJECTIVE_UNCITED);
  }, 30_000);

  it('should count the rests-on that a superseding decision inherits from its lineage', () => {
    const result = runReport(['feat-inherit']);

    expect(result.status).toBe(0);
    expect(rowsOf(result)).toEqual([
      [
        inheritedIds['d-new'] ?? '',
        'feat-inherit.decision.d-old',
        'only-objective: uncited=feat-inherit.premise.alpha',
      ],
    ]);
  }, 30_000);

  it('should print nothing to flag when the process has nothing to flag', () => {
    const result = runReport(['feat-clean']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('nothing to flag\n');
  }, 30_000);

  it('should warn PROCESS_NOT_FOUND on stderr, with no stdout and status 0, for a missing process', () => {
    const result = runReport(['ghost']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: [\s\S]*PROCESS_NOT_FOUND/);
  }, 30_000);

  it('should warn LEGACY_DATA on stderr, with no stdout and status 0, for legacy 0.x data', () => {
    const legacy = createTempDir('flow-report-legacy');
    fs.cpSync(path.join(__dirname, 'fixtures', 'legacy-0x'), path.join(legacy, 'hexlog'), {
      recursive: true,
    });

    const result = runReport(['feat-r'], { xdg: legacy });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: [\s\S]*LEGACY_DATA/);
  }, 30_000);

  it('should warn from git and keep only the only-objective for an unknown base ref', () => {
    const result = runReport(['feat-r', 'origin/nope']);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(
      /^flow-report: git: cannot diff HEAD against "origin\/nope", doc-amended skipped\n$/,
    );
    expect(rowFor(result, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
    expect(rowFor(result, 'd-doc')).toBeUndefined();
  }, 30_000);

  it('should exit with usage on stderr and status 0 for a base that looks like an option', () => {
    const result = runReport(['feat-r', '-x']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: usage:/);
  }, 30_000);

  it.each([
    [['Feat_R']],
    [['../x']],
    [['a$b']],
    [['feat-r', 'a b']],
    [['feat-r', 'x;y']],
    [['feat-r', '$(id)']],
  ])(
    'should refuse the invalid slug or base %j with usage on stderr and status 0',
    (args) => {
      const result = runReport(args);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^flow-report: usage:/);
    },
    30_000,
  );

  it('should exit with usage on stderr and status 0 without an argument', () => {
    const result = runReport([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^flow-report: usage:/);
  }, 30_000);

  it('should cut at 100 lines and say how many were omitted', () => {
    const rows = runReport(['feat-many'])
      .stdout.split('\n')
      .filter((line) => line !== '');

    expect(rows).toHaveLength(101);
    expect(rows.at(-1)).toBe('... 1 more omitted');
  }, 30_000);

  it('should list up to 10 uncited premises and count the rest', () => {
    const [row] = rowsOf(runReport(['feat-wide']));
    const uncited = row?.[2]?.split('uncited=')[1];

    expect(uncited?.endsWith(' (+2)')).toBe(true);
    expect(uncited?.replace(' (+2)', '').split(',')).toHaveLength(10);
  }, 30_000);

  it('should print exactly 100 lines without the omitted line', () => {
    const rows = runReport(['feat-edge-lines'])
      .stdout.split('\n')
      .filter((line) => line !== '');

    expect(rows).toHaveLength(100);
    expect(rows.join('\n')).not.toContain('omitted');
  }, 30_000);

  it('should list exactly 10 uncited premises without the count suffix', () => {
    const [row] = rowsOf(runReport(['feat-edge-wide']));
    const uncited = row?.[2]?.split('uncited=')[1];

    expect(uncited).not.toContain('(+');
    expect(uncited?.split(',')).toHaveLength(10);
  }, 30_000);
});
