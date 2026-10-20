import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import {
  createFlowEnvironment,
  passedVerification,
  registerFlowRecord,
  type FlowRecord,
} from './flow-data.ts';
import { copyToXdg } from './helpers.ts';
import type { Environment } from './mcp/environment.ts';

const gatePath = path.resolve(__dirname, '..', 'scripts/flow/gate.ts');
const SLUG = 'feat-x';

let environment: Environment;

beforeEach(async () => {
  environment = await createFlowEnvironment([SLUG]);
});

afterEach(async () => {
  await environment.close();
});

function runGate(args: string[], xdg = copyToXdg(environment.dataDir)) {
  return spawnSync(process.execPath, [gatePath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
  });
}

const register = (record: FlowRecord) => registerFlowRecord(environment, SLUG, record);

const urgentFinding: FlowRecord = {
  type: 'finding',
  target: `${SLUG}.finding.a`,
  data: { severity: 'URGENT', origin: 'review', description: 'No upper bound', location: 'a.ts' },
};

const openGap: FlowRecord = {
  type: 'gap',
  target: `${SLUG}.gap.a`,
  data: { question: 'How many attempts?', context: 'No directive covers it' },
};

describe('gate.ts pre-pr', () => {
  test('exits 0 with both gates green', async () => {
    await register(passedVerification(SLUG));

    const result = runGate(['pre-pr', SLUG]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  }, 30_000);

  test('exits 1 listing an URGENT finding without resolves-finding', async () => {
    await register(passedVerification(SLUG));
    const findingId = await register(urgentFinding);

    const result = runGate(['pre-pr', SLUG]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`pre-pr: no_pending: ${findingId}\n`);
  }, 30_000);

  test('exits 1 listing a gap without a closer', async () => {
    await register(passedVerification(SLUG));
    const gapId = await register(openGap);

    const result = runGate(['pre-pr', SLUG]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`gaps: no_pending: ${gapId}\n`);
  }, 30_000);

  test('evaluates the gate pinned in the process, so a missing verification fails occurred', () => {
    const result = runGate(['pre-pr', SLUG]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('pre-pr: occurred\n');
  }, 30_000);

  test('exits 2 on 0.x data', () => {
    environment.seedLegacy();

    const result = runGate(['pre-pr', SLUG]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/LEGACY_DATA/);
  }, 30_000);

  test.each([
    [[]],
    [['nope', SLUG]],
    [['pre-pr']],
    [['pre-pr', 'Bad Slug']],
    [['pre-pr', SLUG, 'x']],
  ])(
    'exits 1 with the usage for the arguments %j',
    (args) => {
      const result = runGate(args);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/usage: node scripts\/flow\/gate\.ts pre-pr <slug>/);
    },
    30_000,
  );
});
