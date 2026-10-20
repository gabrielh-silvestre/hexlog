import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { composeReader } from '../src/compose.ts';
import { Name } from '../src/domain/ids.ts';
import { VERSION } from '../src/version.ts';
import { createFlowEnvironment, registerFlowRecord, type FlowRecord } from './flow-data.ts';
import { copyToXdg, createTempDir, snapshot } from './helpers.ts';
import type { Environment } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const reanchorPath = path.join(repoRoot, 'scripts/flow/reanchor.ts');
const gatePath = path.join(repoRoot, 'scripts/flow/gate.ts');
const PROJECT = Name.parse('hexlog');

type HomeOptions = { dirty?: boolean; folder?: string; claudeJson?: boolean };

let environment: Environment;
let commit: string;
// ids das diretrizes nas duas gerações e das decisões do trabalho, por nome curto
const ids: Record<string, string> = {};

const idOf = (name: string): string => {
  const id = ids[name];
  if (id === undefined) throw new Error(`no fixture id "${name}"`);
  return id;
};

const directive = (target: string, rule: string, source: string): FlowRecord => ({
  type: 'directive',
  target,
  data: { rule, section: 'Section', source },
});

const premise = (target: string, statement: string): FlowRecord => ({
  type: 'premise',
  target,
  data: { statement },
});

const decision = (target: string, relations: Record<string, unknown>[]): FlowRecord => ({
  type: 'decision',
  target,
  data: {
    choice: `Choice ${target}`,
    alternatives: [{ option: 'Other', reason: 'Not needed' }],
    rationale: 'Because',
    grounds: 'directive',
    confidence: 'high',
  },
  relations,
});

const anchoredIn = (to: string) => ({ kind: 'derivesFrom', as: 'anchored-in', to });
const restsOn = (to: string) => ({ kind: 'derivesFrom', as: 'rests-on', to });

async function register(process: string, record: FlowRecord, name: string): Promise<void> {
  ids[name] = await registerFlowRecord(environment, process, record);
}

beforeAll(async () => {
  commit = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  environment = await createFlowEnvironment(['directives-1', 'directives-2', 'feat-a', 'feat-b']);
  const { hash: source } = await environment.ok<{ hash: string }>('attach', {
    project: 'hexlog',
    text: 'rule text',
  });
  // `r2` muda de texto entre as gerações; `r1` e `p1` ficam iguais
  await register(
    'directives-1',
    directive('directives.convencoes.r1', 'Rule one', source),
    'g1.r1',
  );
  await register(
    'directives-1',
    directive('directives.convencoes.r2', 'Rule two', source),
    'g1.r2',
  );
  await register('directives-1', premise('directives.estrategia.p1', 'Premise one'), 'g1.p1');
  await register(
    'directives-2',
    directive('directives.convencoes.r1', 'Rule one', source),
    'g2.r1',
  );
  await register(
    'directives-2',
    directive('directives.convencoes.r2', 'Rule two, amended', source),
    'g2.r2',
  );
  await register('directives-2', premise('directives.estrategia.p1', 'Premise one'), 'g2.p1');

  await register('feat-a', premise('feat-a.premise.objective', 'Objective'), 'a.objective');
  await register(
    'feat-a',
    decision('feat-a.decision.same', [
      anchoredIn(idOf('g1.r1')),
      restsOn(idOf('g1.p1')),
      restsOn(idOf('a.objective')),
    ]),
    'a.same',
  );
  await register(
    'feat-a',
    decision('feat-a.decision.changed', [anchoredIn(idOf('g1.r2'))]),
    'a.changed',
  );

  await register(
    'feat-b',
    {
      type: 'finding',
      target: 'feat-b.finding.a',
      data: { severity: 'URGENT', origin: 'review', description: 'No bound', location: 'a.ts' },
    },
    'b.finding',
  );
  await register(
    'feat-b',
    decision('feat-b.decision.fix', [
      anchoredIn(idOf('g1.r1')),
      { kind: 'answers', as: 'resolves-finding', to: idOf('b.finding') },
    ]),
    'b.fix',
  );
  await register(
    'feat-b',
    { type: 'gap', target: 'feat-b.gap.a', data: { question: 'How many?', context: 'No rule' } },
    'b.gap',
  );
  await register(
    'feat-b',
    {
      type: 'premise',
      target: 'feat-b.premise.fills',
      data: { statement: 'Closes the gap' },
      relations: [{ kind: 'answers', as: 'fills-gap', to: idOf('b.gap') }],
    },
    'b.fills',
  );
}, 60_000);

afterAll(async () => {
  await environment.close();
});

/** `HOME` temporário com o servidor registrado e o manifesto de build, no commit do `HEAD` deste repositório. */
function makeHome({
  dirty = false,
  folder = VERSION,
  claudeJson = true,
}: HomeOptions = {}): string {
  const home = createTempDir('home');
  const versionDir = path.join(home, '.local/lib/hexlog', folder);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(
    path.join(versionDir, 'manifest.json'),
    JSON.stringify({ version: folder, commit, dirty }),
  );
  if (claudeJson) {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { hexlog: { command: 'node', args: [path.join(versionDir, 'server.mjs')] } },
      }),
    );
  }
  return home;
}

function runReanchor(args: string[], xdg: string, home = makeHome()) {
  return spawnSync(process.execPath, [reanchorPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg, HOME: home },
  });
}

function runGate(slug: string, xdg: string) {
  return spawnSync(process.execPath, [gatePath, 'pre-pr', slug], {
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
  });
}

/** Decisão vigente de `target` com as arestas de saída como `nome:destino`, ordenadas. */
function currentDecision(xdg: string, proc: string, target: string) {
  const reader = composeReader({
    dataDir: path.join(xdg, 'hexlog'),
    cwd: process.cwd(),
    logger: () => undefined,
  });
  const { records } = reader.query.queryRecords({
    project: PROJECT,
    process: Name.parse(proc),
    type: Name.parse('decision'),
    relations: 'full',
    limit: Number.MAX_SAFE_INTEGER,
  });
  const found = records.filter((record) => record.target === target);
  expect(found).toHaveLength(1);
  const [only] = found;
  return {
    id: only?.id,
    edges: (only?.out ?? []).map(({ kind, as, to }) => `${as ?? kind}:${to}`).sort(),
  };
}

describe('reanchor.ts dry-run', () => {
  test('prints the plan, leaves the data untouched and reports the install check', () => {
    const xdg = copyToXdg(environment.dataDir);
    const before = snapshot(xdg);

    const result = runReanchor(['--to', 'directives-2'], xdg);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('reanchor to directives-2 (dry-run)');
    expect(result.stdout).toContain('rewritable: 2');
    expect(result.stdout).toContain('  feat-a: 1');
    expect(result.stdout).toContain('  feat-b: 1');
    expect(result.stdout).toContain('for the owner: 1');
    expect(result.stdout).toMatch(
      /feat-a\tfeat-a\.decision\.changed\t.*\(directives\.convencoes\.r2\): changed/,
    );
    expect(result.stdout).toContain('install check: ok');
    expect(result.stderr).toBe('');
    expect(snapshot(xdg)).toEqual(before);
  }, 30_000);

  test('turns an install problem into a warning and keeps going', () => {
    const xdg = copyToXdg(environment.dataDir);
    const before = snapshot(xdg);

    const result = runReanchor(['--to', 'directives-2'], xdg, makeHome({ dirty: true }));

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/^warning: installed build has a dirty tree/m);
    expect(result.stdout).toContain('rewritable: 2');
    expect(snapshot(xdg)).toEqual(before);
  }, 30_000);

  test('says there is nothing to reanchor when no decision is anchored in an older generation', async () => {
    const empty = await createFlowEnvironment(['directives-1', 'directives-2', 'feat-empty']);
    try {
      const result = runReanchor(['--to', 'directives-2'], copyToXdg(empty.dataDir));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('nothing to reanchor');
    } finally {
      await empty.close();
    }
  }, 30_000);
});

describe('reanchor.ts --apply', () => {
  test('rewrites the decisions of identical anchors, keeps the others and is idempotent', () => {
    const xdg = copyToXdg(environment.dataDir);

    const result = runReanchor(['--to', 'directives-2', '--apply'], xdg);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('rewrote 2 of 2 decisions');

    const same = currentDecision(xdg, 'feat-a', 'feat-a.decision.same');
    expect(same.id).not.toBe(idOf('a.same'));
    expect(same.edges).toEqual(
      [
        `anchored-in:${idOf('g2.r1')}`,
        `rests-on:${idOf('g2.p1')}`,
        `rests-on:${idOf('a.objective')}`,
        `supersedes:${idOf('a.same')}`,
      ].sort(),
    );
    expect(currentDecision(xdg, 'feat-a', 'feat-a.decision.changed').id).toBe(idOf('a.changed'));

    const written = snapshot(xdg);
    const again = runReanchor(['--to', 'directives-2', '--apply'], xdg);

    expect(again.status).toBe(0);
    expect(again.stdout).toContain('rewritable: 0');
    expect(again.stdout).toContain('for the owner: 1');
    expect(snapshot(xdg)).toEqual(written);
  }, 60_000);

  test('keeps the pre-pr gate result for a resolved URGENT finding and a closed gap', () => {
    const xdg = copyToXdg(environment.dataDir);
    const before = runGate('feat-b', xdg);

    const result = runReanchor(['--to', 'directives-2', '--apply'], xdg);
    const after = runGate('feat-b', xdg);

    expect(before.status).toBe(0);
    expect(result.status).toBe(0);
    expect(currentDecision(xdg, 'feat-b', 'feat-b.decision.fix').id).not.toBe(idOf('b.fix'));
    expect(after.status).toBe(before.status);
    expect(after.stderr).toBe(before.stderr);
  }, 60_000);

  test('reports a batch the register refuses, keeps the other processes and exits 1', async () => {
    const refused = await createFlowEnvironment([
      'directives-1',
      'directives-2',
      'feat-c',
      'feat-d',
    ]);
    try {
      const { hash: source } = await refused.ok<{ hash: string }>('attach', {
        project: 'hexlog',
        text: 'rule text',
      });
      const g1 = await registerFlowRecord(
        refused,
        'directives-1',
        directive('directives.convencoes.r1', 'Rule one', source),
      );
      await registerFlowRecord(
        refused,
        'directives-2',
        directive('directives.convencoes.r1', 'Rule one', source),
      );
      for (const slug of ['feat-c', 'feat-d']) {
        await registerFlowRecord(
          refused,
          slug,
          decision(`${slug}.decision.same`, [anchoredIn(g1)]),
        );
      }

      // O 1º apply, numa cópia, revela a `key` do lote de feat-d; o lote com a mesma `key` e outro
      // conteúdo, gravado antes, faz o `register` real devolver IDEMPOTENCY_CONFLICT.
      const probe = copyToXdg(refused.dataDir);
      expect(runReanchor(['--to', 'directives-2', '--apply'], probe).status).toBe(0);
      const log = fs.readFileSync(
        path.join(probe, 'hexlog/.v1/hexlog/feat-d/records.jsonl'),
        'utf8',
      );
      const key = /"key":"(reanchor-directives-2-feat-d-[^"]+)"/.exec(log)?.[1];
      expect(key).toBeDefined();
      await refused.ok('register', {
        project: 'hexlog',
        process: 'feat-d',
        agent: 'flow-run',
        key,
        records: [
          { type: 'premise', target: 'feat-d.premise.other', data: { statement: 'Other' } },
        ],
      });

      const xdg = copyToXdg(refused.dataDir);
      const before = currentDecision(xdg, 'feat-d', 'feat-d.decision.same');
      const result = runReanchor(['--to', 'directives-2', '--apply'], xdg);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`batch refused: feat-d ${key}`);
      expect(result.stdout).toContain('rewrote 1 of 2 decisions');
      expect(currentDecision(xdg, 'feat-c', 'feat-c.decision.same').edges).toContainEqual(
        expect.stringMatching(/^supersedes:/),
      );
      expect(currentDecision(xdg, 'feat-d', 'feat-d.decision.same')).toEqual(before);
    } finally {
      await refused.close();
    }
  }, 120_000);

  test.each([
    ['a dirty build', { dirty: true }, /dirty tree/],
    ['a missing ~/.claude.json', { claudeJson: false }, /not registered in ~\/\.claude\.json/],
    ['another installed version', { folder: '0.0.1' }, /is not version/],
  ] satisfies [string, HomeOptions, RegExp][])(
    'refuses before writing with %s',
    (_title, options, message) => {
      const xdg = copyToXdg(environment.dataDir);
      const before = snapshot(xdg);

      const result = runReanchor(['--to', 'directives-2', '--apply'], xdg, makeHome(options));

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(message);
      expect(snapshot(xdg)).toEqual(before);
    },
    30_000,
  );
});

describe('reanchor.ts refusals', () => {
  test.each([['directives-1'], ['directives-3']])(
    'exits 1 when --to %s is not the latest generation listed, with and without --apply',
    (to) => {
      const xdg = copyToXdg(environment.dataDir);
      const before = snapshot(xdg);

      for (const flags of [[], ['--apply']]) {
        const result = runReanchor(['--to', to, ...flags], xdg);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/is not the latest directives generation/);
      }
      expect(snapshot(xdg)).toEqual(before);
    },
    60_000,
  );

  test('exits 2 on 0.x data', () => {
    const xdg = copyToXdg(environment.dataDir);
    fs.mkdirSync(path.join(xdg, 'hexlog', 'legacy-project'));

    const result = runReanchor(['--to', 'directives-2'], xdg);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/LEGACY_DATA/);
  }, 30_000);

  test.each([
    [[]],
    [['--apply']],
    [['--to']],
    [['--to', 'directives-x']],
    [['--to', 'directives-2', 'extra']],
    [['--to', 'directives-2', '--nope']],
  ])(
    'exits 1 with the usage for the arguments %j',
    (args) => {
      const result = runReanchor(args, copyToXdg(environment.dataDir));

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/usage: node scripts\/flow\/reanchor\.ts --to directives-<N>/);
    },
    30_000,
  );
});
