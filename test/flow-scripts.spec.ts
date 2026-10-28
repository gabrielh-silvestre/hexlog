import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESERVED_PROCESS_NAMES } from '../src/domain/ids.ts';
import { createFlowEnvironment, registerFlowRecord } from './flow-data.ts';
import {
  NO_MARKER,
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
import { copyToXdg } from './helpers.ts';

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

  it('should make the pre-pr hook accept the PR and gh pr ready only after the mark', () => {
    expectDenied(mcpCreate('feat/x'), NO_MARKER);
    expectDenied(bash('gh pr create --title t'), NO_MARKER);
    expectDenied(bash('gh pr ready'), NO_MARKER);

    const result = runMark('feat-x');

    expect(result.status).toBe(0);

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

  it('should exit with 2 and write nothing over legacy 0.x data', () => {
    const legacyXdg = copyToXdg(path.join(__dirname, 'fixtures', 'legacy-0x'));

    const result = runMark('feat-x', repoState.repo, legacyXdg);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^hexlog flow mark failed: LEGACY_DATA/);
    expect(fs.existsSync(repoState.markerDir)).toBe(false);
  }, 15_000);
});

const importSpecifiers = (file: string): (string | undefined)[] =>
  [...fs.readFileSync(path.join(repoRoot, file), 'utf8').matchAll(/from '([^']+)'/g)].map(
    (match) => match[1],
  );

describe('scripts/flow/marker.ts', () => {
  it('should import only node builtins', () => {
    const specifiers = importSpecifiers('scripts/flow/marker.ts');

    expect(specifiers.length).toBeGreaterThan(0);

    expect(specifiers.filter((specifier) => !specifier?.startsWith('node:'))).toEqual([]);
  });
});

describe('.claude/hooks/flow-command.ts', () => {
  it('should import nothing', () => {
    expect(importSpecifiers('.claude/hooks/flow-command.ts')).toEqual([]);
  });
});
