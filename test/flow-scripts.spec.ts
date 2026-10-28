import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planSync, type SyncInput } from '../scripts/flow/sync.ts';
import { RESERVED_PROCESS_NAMES } from '../src/domain/ids.ts';
import { createFlowEnvironment, registerFlowRecord } from './flow-data.ts';
import {
  bash,
  createRepo,
  expectAllowed,
  expectDenied,
  flowPath,
  markPath,
  mcpCreate,
  repoRoot,
  repoState,
  resetRepo,
  runNode,
  type RunResult,
} from './flow-repo.ts';
import { copyToXdg, createTempDir } from './helpers.ts';

const runFlow = (args: string[], input = ''): RunResult => runNode(flowPath, args, { input });

describe('scripts/flow/flow.ts slug', () => {
  it.each([
    ['feat/x', 'feat-x'],
    ['feat!/v1-cutover', 'feat-v1-cutover'],
    ['docs/a.b_c', 'docs-a-b-c'],
    ['Feat/UPPER', 'feat-upper'],
    [`${'a'.repeat(62)}/b`, 'a'.repeat(62)],
    ['a'.repeat(70), 'a'.repeat(63)],
  ])(
    'should turn the branch %s into the slug %s',
    (branch, expected) => {
      const result = runFlow(['slug', branch]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${expected}\n`);
    },
    15_000,
  );

  it.each([
    '///',
    '',
    'directives',
    'audits',
    'audits-2',
    'directives-4',
    'main',
    'develop',
    ...RESERVED_PROCESS_NAMES,
  ])(
    'should refuse "%s" with exit 1',
    (branch) => {
      const result = runFlow(['slug', branch]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    },
    15_000,
  );
});

describe('scripts/flow/flow.ts sync-plan', () => {
  it('should return the same plan as planSync called directly', () => {
    const input: SyncInput = {
      docSlug: 'convencoes',
      path: 'docs/directives/convencoes.md',
      hash: 'a'.repeat(64),
      current: null,
      vigent: [],
      extracted: [{ slug: 'idioma', rule: 'Código em inglês.', section: 'Idioma' }],
    };

    const result = runFlow(['sync-plan'], JSON.stringify(input));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify(planSync(input))));
  }, 15_000);

  // sem o pré-check o hook leria o arquivo malformado e sairia com 2 e o motivo no stderr
  it.each([
    ['a malformed file', 'estrategia.md', '## Tema\n- sem crase: linha ruim'],
    ['a missing file', 'faltando.md', undefined],
  ])(
    'should not read estrategia given an absolute path to %s',
    (_name, fileName, content) => {
      const file = path.join(createTempDir('strategy'), fileName);
      if (content !== undefined) fs.writeFileSync(file, content);

      const result = runFlow(
        ['sync-plan'],
        JSON.stringify({
          docSlug: 'estrategia',
          path: file,
          hash: '',
          current: null,
          vigent: [],
          extracted: [],
        }),
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({ batches: [], error: 'invalid-path' }),
      );
    },
    15_000,
  );
});

describe('scripts/flow/flow.ts', () => {
  it('should exit with 2 for an unknown mode', () => {
    expectDenied(runFlow(['nope']), /unknown mode/);
  }, 15_000);
});

describe('scripts/flow/mark.ts', () => {
  let xdgHome: string;
  const runMark = (slug: string, cwd = repoState.repo, xdg = xdgHome): RunResult =>
    runNode(markPath, [slug], { cwd, env: { ...process.env, XDG_DATA_HOME: xdg } });
  const markerFile = (slug: string): string => path.join(repoState.markerDir, `${slug}.ok`);

  beforeAll(createRepo, 15_000);
  // dado do hexlog com os gates verdes (sem URGENT nem lacuna) para os dois trabalhos que o `mark` marca
  beforeAll(async () => {
    const flow = await createFlowEnvironment(['feat-x', 'feat-y']);
    xdgHome = copyToXdg(flow.dataDir);
    await flow.close();
  }, 30_000);
  beforeEach(resetRepo);

  it('should write the marker in the git-common-dir', () => {
    const result = runMark('feat-x');

    expect(result.status).toBe(0);
    expect(fs.readFileSync(markerFile('feat-x'), 'utf8')).toBe(`feat/x\n${repoState.tipSha}\n`);
  }, 15_000);

  it('should make the pre-pr hook accept the PR and gh pr ready', () => {
    runMark('feat-x');

    expectAllowed(mcpCreate('feat/x'));
    expectAllowed(bash('gh pr create --title t'));
    expectAllowed(bash('gh pr ready'));
  }, 15_000);

  it('should write to the shared git-common-dir when run in a worktree', () => {
    const result = runMark('feat-y', repoState.worktree);

    expect(result.status).toBe(0);
    expect(fs.existsSync(markerFile('feat-y'))).toBe(true);
  }, 15_000);

  describe('with a dirty working tree', () => {
    const dirty = (): string => path.join(repoState.repo, 'dirty.txt');

    beforeEach(() => {
      fs.writeFileSync(dirty(), 'x');
    });
    afterEach(() => {
      fs.rmSync(dirty(), { force: true });
    });

    it('should write the marker when the gates are green', () => {
      const result = runMark('feat-x');

      expect(result.status).toBe(0);
      expect(fs.readFileSync(markerFile('feat-x'), 'utf8')).toBe(`feat/x\n${repoState.tipSha}\n`);
    }, 15_000);
  });

  describe('with a red gate', () => {
    let findingId: string;
    let redXdg: string;
    let closeFlow: () => Promise<void>;

    beforeAll(async () => {
      const flow = await createFlowEnvironment(['feat-x']);
      closeFlow = () => flow.close();
      findingId = await registerFlowRecord(flow, 'feat-x', {
        type: 'finding',
        target: 'feat-x.finding.a',
        data: { severity: 'URGENT', origin: 'review', description: 'No bound', location: 'a.ts' },
      });
      redXdg = copyToXdg(flow.dataDir);
    }, 30_000);
    afterAll(async () => {
      await closeFlow();
    });

    it('should refuse and write nothing', () => {
      const result = runMark('feat-x', repoState.repo, redXdg);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`gates are not green\npre-pr: no_pending: ${findingId}`);
      expect(fs.existsSync(repoState.markerDir)).toBe(false);
    }, 15_000);
  });

  it('should refuse a branch that yields no slug', () => {
    const result = runMark('other-slug');

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not yield slug/);
    expect(fs.existsSync(repoState.markerDir)).toBe(false);
  }, 15_000);
});

describe('scripts/flow/marker.ts', () => {
  it('should import only node builtins', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'scripts/flow/marker.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers.length).toBeGreaterThan(0);

    expect(specifiers.filter((specifier) => !specifier?.startsWith('node:'))).toEqual([]);
  });
});
