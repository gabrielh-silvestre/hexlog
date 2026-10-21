import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compose } from '../src/compose.ts';
import { AUTHOR, NOTE, NOW, PROJECT, note } from './commands/register-fakes.ts';
import { at, createTempDir } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
const REF = { project: PROJECT, process: 'run-1' };

let xdgHome: string;
let ids: { unit: string; evidence: string; revised: string };

const run = (script: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [`scripts/${script}.ts`, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdgHome },
    timeout: 20_000,
  });
  return { code: result.status, out: result.stdout };
};

// run-1: a evidência apoia a unidade, que é superada por uma versão sem relações.
// Cada describe de topo liga esta função ao hook: `jest/require-top-level-describe` barra hook fora de describe.
const seedInheritance = async () => {
  xdgHome = createTempDir('xdg');
  const dataDir = path.join(xdgHome, 'hexlog');
  fs.mkdirSync(dataDir);
  const { services } = compose({
    dataDir,
    cwd: xdgHome,
    clock: () => NOW,
    logger: () => undefined,
  });
  services.definition.defineType({ project: PROJECT, name: 'note', schema: NOTE });
  services.process.createProcess(REF);
  const register = async (key: string, item: ReturnType<typeof note>) => {
    const { records } = await services.process.register({
      ...REF,
      author: AUTHOR,
      key,
      records: [item],
    });
    return at(records, 0).id;
  };
  const unit = await register('k1', note('unit', { target: 'run.unit' }));
  const evidence = await register(
    'k2',
    note('evidence', { target: 'run.ev', relations: [{ to: unit, kind: 'supports' }] }),
  );
  const revised = await register(
    'k3',
    note('unit 2', { target: 'run.unit', relations: [{ to: unit, kind: 'supersedes' }] }),
  );
  ids = { unit, evidence, revised };
};

describe('scripts/export.ts', () => {
  beforeAll(seedInheritance);

  it('should give each record the inherited edges with the stored edge as origin', () => {
    const origin = { from: ids.evidence, to: ids.unit };

    const { code, out } = run('export', `${PROJECT}/run-1`);
    const lines = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.find(({ id }) => id === ids.revised)).toMatchObject({
      inheritedIn: [{ kind: 'supports', from: ids.evidence, origin }],
    });
    expect(lines.find(({ id }) => id === ids.evidence)).toMatchObject({
      inheritedOut: [{ kind: 'supports', to: ids.revised, origin }],
    });
    expect(code).toBe(0);
  }, 30_000);

  it('should accept inheritedIn and inheritedOut in --fields', () => {
    const { code, out } = run('export', `${PROJECT}/run-1`, '--fields', 'id,inheritedIn');
    const lines = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.find(({ id }) => id === ids.revised)).toHaveProperty('inheritedIn');

    for (const line of lines) expect(line).not.toHaveProperty('inheritedOut');

    expect(code).toBe(0);
  }, 30_000);
});

describe('scripts/timeline.ts', () => {
  beforeAll(seedInheritance);

  it('should print inherited in and inherited out with the origin in the readable text', () => {
    const origin = `origin ${ids.evidence} -> ${ids.unit}`;

    const { code, out } = run('timeline', PROJECT, 'run');

    expect(out).toContain(`inherited in: supports <- ${ids.evidence} (${origin})`);
    expect(out).toContain(`inherited out: supports -> ${ids.revised} (${origin})`);
    expect(code).toBe(0);
  }, 30_000);
});
