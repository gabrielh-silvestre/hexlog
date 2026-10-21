import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { createFlowEnvironment, registerFlowRecord, type FlowRecord } from './flow-data.ts';
import { copyToXdg } from './helpers.ts';
import type { Environment } from './mcp/environment.ts';

const gatePath = path.resolve(__dirname, '..', 'scripts/flow/gate.ts');
const SLUG = 'feat-x';

let environment: Environment;

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

describe('scripts/flow/gate.ts', () => {
  beforeEach(async () => {
    environment = await createFlowEnvironment([SLUG]);
  });

  afterEach(async () => {
    await environment.close();
  });

  it('should exit 0 for pre-pr with both gates green', () => {
    const result = runGate(['pre-pr', SLUG]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  }, 30_000);

  it('should exit 1 for pre-pr listing an URGENT finding without resolves-finding', async () => {
    const findingId = await register(urgentFinding);

    const result = runGate(['pre-pr', SLUG]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`pre-pr: no_pending: ${findingId}\n`);
  }, 30_000);

  it('should exit 1 for pre-pr listing a gap without a closer', async () => {
    const gapId = await register(openGap);

    const result = runGate(['pre-pr', SLUG]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`gaps: no_pending: ${gapId}\n`);
  }, 30_000);

  it('should exit 2 on 0.x data', () => {
    environment.seedLegacy();

    const result = runGate(['pre-pr', SLUG]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/LEGACY_DATA/);
  }, 30_000);

  it.each([
    [[]],
    [['nope', SLUG]],
    [['pre-pr']],
    [['pre-pr', 'Bad Slug']],
    [['pre-pr', SLUG, 'x']],
  ])(
    'should exit 1 with the usage for the arguments %j',
    (args) => {
      const result = runGate(args);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/usage: node scripts\/flow\/gate\.ts pre-pr <slug>/);
    },
    30_000,
  );
});
