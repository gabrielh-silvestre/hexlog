import { beforeAll, describe, expect, it } from '@jest/globals';
import { PROJECT, note, runScript, seedNoteProcess } from './commands/fakes.ts';
import { jsonLines } from './helpers.ts';

let xdgHome: string;
let ids: { unit: string; evidence: string; revised: string };

// run-1: a evidência apoia a unidade, que é superada por uma versão sem relações.
const seedInheritance = async () => {
  const { xdg, register } = seedNoteProcess();
  const unit = await register('k1', note('unit', { target: 'run.unit' }));
  const evidence = await register(
    'k2',
    note('evidence', { target: 'run.ev', relations: [{ to: unit, kind: 'supports' }] }),
  );
  const revised = await register(
    'k3',
    note('unit 2', { target: 'run.unit', relations: [{ to: unit, kind: 'supersedes' }] }),
  );
  xdgHome = xdg;
  ids = { unit, evidence, revised };
};

describe('scripts/export.ts', () => {
  beforeAll(seedInheritance);

  it('should give each record the inherited edges with the stored edge as origin', () => {
    const origin = { from: ids.evidence, to: ids.unit };

    const { code, out } = runScript('export', xdgHome, `${PROJECT}/run-1`);
    const lines = jsonLines<Record<string, unknown>>(out);

    expect(lines.find(({ id }) => id === ids.revised)).toMatchObject({
      inheritedIn: [{ kind: 'supports', from: ids.evidence, origin }],
    });
    expect(lines.find(({ id }) => id === ids.evidence)).toMatchObject({
      inheritedOut: [{ kind: 'supports', to: ids.revised, origin }],
    });
    expect(code).toBe(0);
  }, 30_000);

  it('should accept inheritedIn in --fields and omit the inherited edges that were not requested', () => {
    const { code, out } = runScript(
      'export',
      xdgHome,
      `${PROJECT}/run-1`,
      '--fields',
      'id,inheritedIn',
    );
    const lines = jsonLines<Record<string, unknown>>(out);

    expect(lines.find(({ id }) => id === ids.revised)).toHaveProperty('inheritedIn');

    for (const line of lines) expect(line).not.toHaveProperty('inheritedOut');

    expect(code).toBe(0);
  }, 30_000);
});

describe('scripts/timeline.ts', () => {
  beforeAll(seedInheritance);

  it('should print inherited in and inherited out with the origin in the readable text', () => {
    const origin = `origin ${ids.evidence} -> ${ids.unit}`;

    const { code, out } = runScript('timeline', xdgHome, PROJECT, 'run');

    expect(out).toContain(`inherited in: supports <- ${ids.evidence} (${origin})`);
    expect(out).toContain(`inherited out: supports -> ${ids.revised} (${origin})`);
    expect(code).toBe(0);
  }, 30_000);
});
