import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReportFixture, type ReportFixture } from './flow-report-fixture.ts';
import { at, createTempDir } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');

type Result = SpawnSyncReturns<string>;

describe('scripts/flow/report.ts', () => {
  const reportPath = path.join(repoRoot, 'scripts/flow/report.ts');
  let fixture: ReportFixture;

  beforeAll(async () => {
    fixture = await createReportFixture();
  }, 60_000);

  function runReport(args: string[], options: { xdg?: string } = {}): Result {
    return spawnSync(process.execPath, [reportPath, ...args], {
      cwd: fixture.gitRepo,
      encoding: 'utf8',
      env: { ...process.env, XDG_DATA_HOME: options.xdg ?? fixture.xdg },
    });
  }

  const linesOf = (result: Result): string[] =>
    result.stdout.split('\n').filter((line) => line !== '');

  /** Colunas por TAB de cada linha impressa. */
  const rowsOf = (result: Result): string[][] => linesOf(result).map((line) => line.split('\t'));

  const rowFor = (result: Result, name: string): string[] | undefined =>
    rowsOf(result).find(([id]) => id === fixture.idOf(name));

  /** A linha que o relatório imprime para o registro `name` do fixture, com o motivo dado. */
  const rowOf = (name: string, reason: string): string[] => [
    fixture.idOf(name),
    fixture.targetOf(name),
    reason,
  ];

  const OBJECTIVE_UNCITED = 'only-objective: uncited=feat-r.premise.alpha,feat-r.premise.beta';
  const DOC_AMENDED = 'doc-amended: docs/directives/convencoes.md (directives.convencoes.r1)';
  const OPEN_PENDING = 'critical-gap: open, approval pending';
  const notApproved = (premiseShort: string): string =>
    `rests-on-simulated: feat-c.premise.${premiseShort} has no simulated-approved`;

  describe('with the default base', () => {
    let result: Result;

    beforeAll(() => {
      result = runReport(['feat-r']);
    }, 30_000);

    it('should exit with status 0 and no warning on stderr', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/flow-report:/);
    });

    it.each([
      {
        label: 'the decision that cites only the objective premise, with the uncited premises',
        name: 'd-obj',
        reason: OBJECTIVE_UNCITED,
      },
      {
        label: 'the decision that cites only the sentinel, with the uncited premises',
        name: 'd-none',
        reason:
          'only-sentinel: uncited=feat-r.premise.objective,feat-r.premise.alpha,feat-r.premise.beta',
      },
      {
        label: 'the decision that cites the objective and the sentinel together',
        name: 'd-both-none',
        reason: OBJECTIVE_UNCITED.replace('only-objective:', 'only-objective+sentinel:'),
      },
      {
        label: 'as doc-amended the decision anchored in a doc changed in the diff',
        name: 'd-doc',
        reason: DOC_AMENDED,
      },
      {
        label: 'both reasons on the same line, separated by "; "',
        name: 'd-both',
        reason: `${OBJECTIVE_UNCITED}; ${DOC_AMENDED}`,
      },
    ])('should flag $label', ({ name, reason }) => {
      expect(rowFor(result, name)).toEqual(rowOf(name, reason));
    });

    it.each([
      {
        name: 'd-revoked-prem',
        because: 'cites a revoked premise, which still counts as a citation',
      },
      { name: 'd-ok', because: 'cites a delivery premise' },
      { name: 'd-no-rest', because: 'has no rests-on' },
      {
        name: 'd-far',
        because: 'is anchored in a doc changed only on the base after the merge-base',
      },
      { name: 'd-old', because: 'is not current' },
      { name: 'd-rev', because: 'is not current' },
      { name: 'd-a', because: 'is not current' },
      { name: 'd-b', because: 'is not current' },
      { name: 'd-new', because: 'is current and cites a delivery premise' },
    ])('should not flag $name, which $because', ({ name }) => {
      expect(rowFor(result, name)).toBeUndefined();
    });

    it('should print only ids that the server query reports as current', () => {
      const printed = rowsOf(result)
        .map((row) => at(row, 0))
        .filter((id) => id !== '-');

      expect(printed.length).toBeGreaterThan(0);

      expect([...fixture.currentIds]).toEqual(expect.arrayContaining(printed));
    });

    it('should list a critical doc in the diff that no critical gap covers', () => {
      expect(rowsOf(result).filter(([id]) => id === '-')).toEqual([
        ['-', '-', 'critical-doc-touched: docs/directives/convencoes.md'],
        ['-', '-', 'critical-doc-touched: docs/directives/invariantes.md'],
      ]);
    });
  });

  describe('when the foreign process read fails', () => {
    let result: Result;

    beforeAll(() => {
      result = runReport(['feat-r'], { xdg: fixture.xdgWithoutDirectives });
    }, 30_000);

    it('should exit with status 0 and one warning per prefix, not per id', () => {
      expect(result.status).toBe(0);
      expect(result.stderr.match(/flow-report:/g)).toHaveLength(1);
      expect(result.stderr).toContain('PROCESS_NOT_FOUND');
    });

    it('should keep the only-objective, which does not depend on the foreign process', () => {
      expect(rowFor(result, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
    });

    it.each([
      { name: 'd-none', because: 'cites the sentinel, which lives in the foreign process' },
      { name: 'd-doc', because: 'has no target to compare with the diff' },
    ])('should not wrongly flag $name, which $because', ({ name }) => {
      expect(rowFor(result, name)).toBeUndefined();
    });
  });

  describe('with critical gaps and simulated premises', () => {
    let result: Result;

    beforeAll(() => {
      result = runReport(['feat-c']);
    }, 30_000);

    it.each([
      { label: 'an open critical gap as pending approval', name: 'g-open', reason: OPEN_PENDING },
      {
        label: 'a critical gap closed by a simulated premise',
        name: 'g-sim',
        reason: 'critical-gap: closed by feat-c.premise.sim (answeredBy=simulated)',
      },
      {
        label: 'a gap closed without the amendment of its critical doc in the diff',
        name: 'g-noamend',
        reason: 'critical-gap: docs/directives/fronteiras.md not in the diff',
      },
      {
        label: 'a gap closed by a directive of another process as answeredBy=none',
        name: 'g-dir',
        reason: 'critical-gap-review: closed by directives.convencoes.r9 (answeredBy=none)',
      },
      {
        label: 'a gap closed by a premise without answeredBy when the process pins the field',
        name: 'g-none',
        reason: 'critical-gap: closed by feat-c.premise.none (answeredBy=none, field pinned)',
      },
      {
        label: 'a human closer recorded before the commit that amended the doc',
        name: 'g-human-late',
        reason: 'critical-gap: doc amended after the approval (docs/directives/convencoes.md)',
      },
      {
        label: 'the simulated closer and the late approval of the same gap',
        name: 'g-two',
        reason:
          'critical-gap: closed by feat-c.premise.two-simulated (answeredBy=simulated); ' +
          'critical-gap: doc amended after the approval (docs/directives/convencoes.md)',
      },
      {
        label: 'the doc missing from the diff when only one of the closers is human',
        name: 'g-two-nodiff',
        reason: 'critical-gap: docs/directives/fronteiras.md not in the diff',
      },
      {
        label: 'a simulated-approved recorded before the commit that amended the doc',
        name: 'g-amended',
        reason: 'critical-gap: doc amended after the approval (docs/directives/convencoes.md)',
      },
      {
        label: 'a critical gap without a rule target as an unknown rule doc',
        name: 'g-norule',
        reason: 'critical-gap: rule doc unknown',
      },
      {
        label: 'a gap whose closer was revoked as open',
        name: 'g-revoked',
        reason: OPEN_PENDING,
      },
      {
        label: 'a decision resting on a simulated premise without simulated-approved',
        name: 'd-rests-sim',
        reason: notApproved('open-sim'),
      },
      {
        label: 'a decision resting on a simulated premise whose approval was revoked',
        name: 'd-rests-revoked',
        reason: notApproved('rv-sim'),
      },
    ])('should flag $label', ({ name, reason }) => {
      expect(rowFor(result, name)).toEqual(rowOf(name, reason));
    });

    it.each([
      { name: 'g-ok', because: 'is closed by simulated-approved with the doc in the diff' },
      { name: 'g-human-nodiff', because: 'has a human closer whose doc is not in the diff' },
      {
        name: 'g-human',
        because: 'has a human closer and the doc was amended before the approval',
      },
      { name: 'g-common', because: 'is of the common class' },
      { name: 'g-old', because: 'is a superseded critical gap' },
      { name: 'g-new', because: 'replaced a superseded critical gap' },
      { name: 'd-rests-approved', because: 'rests on a simulated premise with simulated-approved' },
      { name: 'd-rests-common', because: 'rests on a simulated premise that filled a common gap' },
    ])('should not flag $name, which $because', ({ name }) => {
      expect(rowFor(result, name)).toBeUndefined();
    });

    it('should not flag a critical doc that a critical gap covers', () => {
      expect(result.stdout).not.toContain('critical-doc-touched');
    });
  });

  it('should only list a gap closed by a premise without answeredBy when the process does not pin the field', () => {
    const result = runReport(['feat-nopin']);

    expect(rowsOf(result)).toEqual([
      [
        expect.stringMatching(/^feat-nopin:/),
        'feat-nopin.gap.nopin',
        'critical-gap-review: closed by feat-nopin.premise.nopin (answeredBy=none)',
      ],
      ['-', '-', 'critical-doc-touched: docs/directives/convencoes.md'],
    ]);
  }, 30_000);

  describe('with a Class literal in the gap context', () => {
    let result: Result;

    beforeAll(() => {
      result = runReport(['feat-class']);
    }, 30_000);

    it.each(['k-lower', 'k-tight', 'k-spaced', 'k-upper'])(
      'should still read %s as a critical gap',
      (name) => {
        expect(rowFor(result, name)?.[2]).toBe(OPEN_PENDING);
      },
    );

    it('should read the rule of a critical gap whose context ends with a `Nature:` literal', () => {
      expect(rowFor(result, 'k-nature')?.[2]).toBe(OPEN_PENDING);
    });

    it.each(['k-longer', 'k-mixed'])('should not read %s as a critical gap', (name) => {
      expect(rowFor(result, name)).toBeUndefined();
    });

    it('should report an unknown rule doc when the rule carries a terminal control', () => {
      expect(rowFor(result, 'k-control')?.[2]).toBe('critical-gap: rule doc unknown');
      expect(result.stdout).not.toContain('\u001b');
    });
  });

  describe('with a base that git cannot resolve', () => {
    let decisions: Result;
    let gaps: Result;

    beforeAll(() => {
      decisions = runReport(['feat-r', 'origin/nope']);
      gaps = runReport(['feat-c', 'origin/nope']);
    }, 60_000);

    it('should warn from git with the exact message and exit with 0', () => {
      expect(decisions.status).toBe(0);
      expect(decisions.stderr).toMatch(
        /^flow-report: git: cannot diff HEAD against "origin\/nope", doc-amended skipped\n$/,
      );
    });

    it('should keep the only-objective and drop doc-amended', () => {
      expect(rowFor(decisions, 'd-obj')?.[2]).toBe(OBJECTIVE_UNCITED);
      expect(rowFor(decisions, 'd-doc')).toBeUndefined();
    });

    it.each(['g-amended', 'g-noamend'])(
      'should skip the doc checks of the closed gap %s',
      (name) => {
        expect(rowFor(gaps, name)).toBeUndefined();
      },
    );

    it.each([
      { name: 'g-norule', reason: 'critical-gap: rule doc unknown' },
      { name: 'g-open', reason: OPEN_PENDING },
    ])('should still flag $name', ({ name, reason }) => {
      expect(rowFor(gaps, name)?.[2]).toBe(reason);
    });
  });

  it('should drop doc-amended when the base is swapped for feat/r and the diff is empty', () => {
    const result = runReport(['feat-r', 'feat/r']);

    expect(result.status).toBe(0);
    expect(rowFor(result, 'd-doc')).toBeUndefined();
    expect(rowFor(result, 'd-both')?.[2]).toBe(OBJECTIVE_UNCITED);
  }, 30_000);

  it('should count the rests-on that a superseding decision inherits from its lineage', () => {
    const result = runReport(['feat-inherit', 'feat/r']);

    expect(result.status).toBe(0);
    expect(rowsOf(result)).toEqual([
      [
        fixture.inheritedIdOf('d-new'),
        'feat-inherit.decision.d-old',
        'only-objective: uncited=feat-inherit.premise.alpha',
      ],
    ]);
  }, 30_000);

  it('should print nothing to flag when the process has nothing to flag', () => {
    const result = runReport(['feat-clean', 'feat/r']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('nothing to flag\n');
  }, 30_000);

  const legacyXdg = (): string => {
    const legacy = createTempDir('flow-report-legacy');
    fs.cpSync(path.join(__dirname, 'fixtures', 'legacy-0x'), path.join(legacy, 'hexlog'), {
      recursive: true,
    });
    return legacy;
  };

  it.each([
    {
      label: 'a missing process',
      args: ['ghost'],
      stderr: /^flow-report: [\s\S]*PROCESS_NOT_FOUND/,
    },
    {
      label: 'legacy 0.x data',
      args: ['feat-r'],
      xdg: legacyXdg,
      stderr: /^flow-report: [\s\S]*LEGACY_DATA/,
    },
    {
      label: 'a base that looks like an option',
      args: ['feat-r', '-x'],
      stderr: /^flow-report: usage:/,
    },
    { label: 'no argument', args: [], stderr: /^flow-report: usage:/ },
    { label: 'the slug Feat_R', args: ['Feat_R'], stderr: /^flow-report: usage:/ },
    { label: 'the slug ../x', args: ['../x'], stderr: /^flow-report: usage:/ },
    { label: 'the slug a$b', args: ['a$b'], stderr: /^flow-report: usage:/ },
    { label: 'a base with a space', args: ['feat-r', 'a b'], stderr: /^flow-report: usage:/ },
    { label: 'a base with a semicolon', args: ['feat-r', 'x;y'], stderr: /^flow-report: usage:/ },
    {
      label: 'a base with a substitution',
      args: ['feat-r', '$(id)'],
      stderr: /^flow-report: usage:/,
    },
  ])(
    'should warn on stderr only, with status 0, for $label',
    ({ args, xdg, stderr }) => {
      const result = runReport(args, { xdg: xdg?.() });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(stderr);
    },
    30_000,
  );

  describe('with 101 decisions and a critical gap after them', () => {
    let rows: string[];

    beforeAll(() => {
      rows = linesOf(runReport(['feat-cut', 'feat/r']));
    }, 30_000);

    it('should cut at 100 lines and say how many were omitted', () => {
      expect(rows).toHaveLength(101);
      expect(rows.at(-1)).toBe('... 2 more omitted');
    });

    it('should keep the critical gap line when the cut applies', () => {
      expect(rows).toContainEqual(expect.stringMatching(/critical-gap: open, approval pending$/));
    });
  });

  it('should print exactly 100 lines without the omitted line', () => {
    const rows = linesOf(runReport(['feat-edge-lines', 'feat/r']));

    expect(rows).toHaveLength(100);
    expect(rows.join('\n')).not.toContain('omitted');
  }, 30_000);

  describe('with 12 uncited premises', () => {
    let uncited: string | undefined;

    beforeAll(() => {
      const [row] = rowsOf(runReport(['feat-wide', 'feat/r']));
      uncited = row?.[2]?.split('uncited=')[1];
    }, 30_000);

    it('should count the rest after the first 10', () => {
      expect(uncited).toMatch(/ \(\+2\)$/);
    });

    it('should list 10 of them before the count', () => {
      expect(uncited?.replace(' (+2)', '').split(',')).toHaveLength(10);
    });
  });

  it('should list exactly 10 uncited premises without the count suffix', () => {
    const [row] = rowsOf(runReport(['feat-edge-wide', 'feat/r']));
    const uncited = row?.[2]?.split('uncited=')[1];

    expect(uncited).not.toContain('(+');
    expect(uncited?.split(',')).toHaveLength(10);
  }, 30_000);
});
