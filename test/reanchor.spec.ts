import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { composeReader } from '../src/compose.ts';
import { Name } from '../src/domain/ids.ts';
import { VERSION } from '../src/version.ts';
import {
  createFlowEnvironment,
  createLegacyLineageProcess,
  registerFlowRecord,
  type FlowRecord,
} from './flow-data.ts';
import { anchoredIn, copyToXdg, createTempDir, restsOn, snapshot } from './helpers.ts';
import type { Environment } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const reanchorPath = path.join(repoRoot, 'scripts/flow/reanchor.ts');
const gatePath = path.join(repoRoot, 'scripts/flow/gate.ts');
const PROJECT = Name.parse('hexlog');

type HomeOptions = { dirty?: boolean; folder?: string; claudeJson?: boolean; commit?: string };

// Árvore vazia do git: `src/` do `HEAD` sempre difere dela, e não depende do histórico do clone.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

async function register(process: string, record: FlowRecord, name: string): Promise<void> {
  ids[name] = await registerFlowRecord(environment, process, record);
}

/** Abre os processos de `slugs`, roda `run` e fecha o ambiente mesmo se `run` lançar. */
async function withEnvironment<T>(
  slugs: string[],
  run: (opened: Environment) => T | Promise<T>,
): Promise<T> {
  const opened = await createFlowEnvironment(slugs);
  try {
    return await run(opened);
  } finally {
    await opened.close();
  }
}

/** Anexa o texto da regra e grava `directives.convencoes.r1` nas gerações 1 e 2; devolve o anexo e o id da geração 1. */
async function seedRule(opened: Environment): Promise<{ source: string; g1: string }> {
  const { hash: source } = await opened.ok<{ hash: string }>('attach', {
    project: 'hexlog',
    text: 'rule text',
  });
  const g1 = await registerFlowRecord(
    opened,
    'directives-1',
    directive('directives.convencoes.r1', 'Rule one', source),
  );
  await registerFlowRecord(
    opened,
    'directives-2',
    directive('directives.convencoes.r1', 'Rule one', source),
  );
  return { source, g1 };
}

/** As `key` dos lotes que a reancoragem gravou para `proc` em `xdg`, na ordem do log. */
function batchKeys(xdg: string, proc: string): string[] {
  const keyPattern = new RegExp(`"key":"(reanchor-directives-2-${proc}-[^"]+)"`, 'g');
  return [
    ...fs
      .readFileSync(path.join(xdg, 'hexlog/.v1/hexlog', proc, 'records.jsonl'), 'utf8')
      .matchAll(keyPattern),
  ].map(([, key]) => key ?? '');
}

/**
 * Descobre a `key` do lote `index` de `proc` reancorando numa cópia e grava no ambiente real um lote
 * com a mesma `key` e outro conteúdo: o `register` do apply real devolve IDEMPOTENCY_CONFLICT.
 */
async function poisonBatchKey(opened: Environment, proc: string, index = 0): Promise<string> {
  const probe = copyToXdg(opened.dataDir);
  const probed = runReanchor(['--to', 'directives-2', '--apply'], probe);
  if (probed.status !== 0) throw new Error(`probe apply failed: ${probed.stderr}`);
  const key = batchKeys(probe, proc)[index];
  if (key === undefined) throw new Error(`probe apply wrote no batch ${index} for ${proc}`);
  await opened.ok('register', {
    project: 'hexlog',
    process: proc,
    agent: 'flow-run',
    key,
    records: [{ type: 'premise', target: `${proc}.premise.other`, data: { statement: 'Other' } }],
  });
  return key;
}

/** `HOME` temporário com o servidor registrado e o manifesto de build, no commit do `HEAD` deste repositório. */
function makeHome({
  dirty = false,
  folder = VERSION,
  claudeJson = true,
  commit: installedCommit = commit,
}: HomeOptions = {}): string {
  const home = createTempDir('home');
  const versionDir = path.join(home, '.local/lib/hexlog', folder);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(
    path.join(versionDir, 'manifest.json'),
    JSON.stringify({ version: folder, commit: installedCommit, dirty }),
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

function runReanchor(args: string[], xdg: string, home = makeHome(), env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [reanchorPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg, HOME: home, ...env },
  });
}

/** Pasta de objetos de um repositório temporário com a árvore vazia, que o git do script lê como alternativa. */
function emptyTreeObjects(): string {
  const repo = createTempDir('empty-tree');
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' });
  return path.join(repo, '.git/objects');
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
  const [only] = found;
  if (only === undefined || found.length > 1) {
    throw new Error(`expected one current decision for ${target}, found ${found.length}`);
  }
  return {
    id: only.id,
    edges: (only.out ?? []).map(({ kind, as, to }) => `${as ?? kind}:${to}`).sort(),
  };
}

describe('scripts/flow/reanchor.ts', () => {
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

  describe('when run as a dry-run on the fixture data', () => {
    let xdg: string;
    let before: ReturnType<typeof snapshot>;
    let result: ReturnType<typeof runReanchor>;

    beforeAll(() => {
      xdg = copyToXdg(environment.dataDir);
      before = snapshot(xdg);

      result = runReanchor(['--to', 'directives-2'], xdg);
    }, 30_000);

    it('should print the plan', () => {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('reanchor to directives-2 (dry-run)');
      expect(result.stdout).toContain('rewritable: 2');
      expect(result.stdout).toContain('  feat-a: 1');
      expect(result.stdout).toContain('  feat-b: 1');
      expect(result.stdout).toContain('for the owner: 1');
      expect(result.stdout).toMatch(
        /feat-a\tfeat-a\.decision\.changed\t.*\(directives\.convencoes\.r2\): changed/,
      );
    });

    it('should leave the data untouched', () => {
      expect(snapshot(xdg)).toEqual(before);
    });

    it('should report the install check without a warning', () => {
      expect(result.stdout).toContain('install check: ok');
      expect(result.stderr).toBe('');
    });
  });

  describe('when run as a dry-run with an install problem', () => {
    let xdg: string;
    let before: ReturnType<typeof snapshot>;
    let result: ReturnType<typeof runReanchor>;

    beforeAll(() => {
      xdg = copyToXdg(environment.dataDir);
      before = snapshot(xdg);

      result = runReanchor(['--to', 'directives-2'], xdg, makeHome({ dirty: true }));
    }, 30_000);

    it('should turn the install problem into a warning and exit 0', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/^warning: installed build has a dirty tree/m);
    });

    it('should keep going and print the plan', () => {
      expect(result.stdout).toContain('rewritable: 2');
    });

    it('should leave the data untouched', () => {
      expect(snapshot(xdg)).toEqual(before);
    });
  });

  it('should print one warning per install problem on a dry-run', () => {
    const home = makeHome({ dirty: true, folder: '0.0.1' });

    const result = runReanchor(['--to', 'directives-2'], copyToXdg(environment.dataDir), home);

    expect(result.stderr.match(/^warning: /gm)).toHaveLength(2);
  }, 30_000);

  it('should say there is nothing to reanchor when no decision is anchored in an older generation', async () => {
    await withEnvironment(['directives-1', 'directives-2', 'feat-empty'], (empty) => {
      const result = runReanchor(['--to', 'directives-2'], copyToXdg(empty.dataDir));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('nothing to reanchor');
    });
  }, 30_000);

  describe('with --apply on the fixture data', () => {
    let xdg: string;
    let result: ReturnType<typeof runReanchor>;
    let same: ReturnType<typeof currentDecision>;

    beforeAll(() => {
      xdg = copyToXdg(environment.dataDir);

      result = runReanchor(['--to', 'directives-2', '--apply'], xdg);
      same = currentDecision(xdg, 'feat-a', 'feat-a.decision.same');
    }, 60_000);

    it('should report the rewrite of every decision of identical anchors', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('rewrote 2 of 2 decisions');
    });

    it('should give the rewritten decision a new id', () => {
      expect(same.id).not.toBe(idOf('a.same'));
    });

    it('should point the rewritten decision at the new generation and supersede the old one', () => {
      expect(same.edges).toEqual(
        [
          `anchored-in:${idOf('g2.r1')}`,
          `rests-on:${idOf('g2.p1')}`,
          `rests-on:${idOf('a.objective')}`,
          `supersedes:${idOf('a.same')}`,
        ].sort(),
      );
    });

    it('should keep the decision of changed anchors', () => {
      expect(currentDecision(xdg, 'feat-a', 'feat-a.decision.changed').id).toBe(idOf('a.changed'));
    });
  });

  describe('with --apply', () => {
    it('should write nothing on a second --apply over the same data', () => {
      const xdg = copyToXdg(environment.dataDir);
      const first = runReanchor(['--to', 'directives-2', '--apply'], xdg);
      const written = snapshot(xdg);

      expect(first.status).toBe(0);

      const again = runReanchor(['--to', 'directives-2', '--apply'], xdg);

      expect(again.status).toBe(0);
      expect(again.stdout).toContain('rewritable: 0');
      expect(again.stdout).toContain('for the owner: 1');
      expect(snapshot(xdg)).toEqual(written);
    }, 60_000);

    it('should keep the pre-pr gate result for a resolved URGENT finding and a closed gap', () => {
      const xdg = copyToXdg(environment.dataDir);
      const before = runGate('feat-b', xdg);

      expect(before.status).toBe(0);

      const result = runReanchor(['--to', 'directives-2', '--apply'], xdg);
      const after = runGate('feat-b', xdg);

      expect(result.status).toBe(0);
      expect(currentDecision(xdg, 'feat-b', 'feat-b.decision.fix').id).not.toBe(idOf('b.fix'));
      expect(after.status).toBe(before.status);
      expect(after.stderr).toBe(before.stderr);
    }, 60_000);

    it('should send to the owner a decision supported by an evidence of another process', async () => {
      await withEnvironment(['directives-1', 'directives-2', 'feat-q'], async (supported) => {
        createLegacyLineageProcess(supported, 'feat-p');
        const { source, g1 } = await seedRule(supported);
        const target = await registerFlowRecord(
          supported,
          'feat-p',
          decision('feat-p.decision.supported', [anchoredIn(g1)]),
        );
        await registerFlowRecord(supported, 'feat-q', {
          type: 'evidence',
          target: 'feat-q.evidence.x',
          data: { summary: 'Backs the decision', source },
          relations: [{ kind: 'supports', to: target }],
        });
        const xdg = copyToXdg(supported.dataDir);
        const before = snapshot(xdg);

        const result = runReanchor(['--to', 'directives-2', '--apply'], xdg);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('rewritable: 0');
        expect(result.stdout).toMatch(/feat-p\tfeat-p\.decision\.supported\t.*\tsupported/);
        expect(snapshot(xdg)).toEqual(before);
      });
    }, 60_000);

    it('should refuse before writing when src/ differs from the installed commit', () => {
      const xdg = copyToXdg(environment.dataDir);
      const before = snapshot(xdg);
      const home = makeHome({ commit: EMPTY_TREE });

      const result = runReanchor(['--to', 'directives-2', '--apply'], xdg, home, {
        GIT_ALTERNATE_OBJECT_DIRECTORIES: emptyTreeObjects(),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/src\/ differs from the installed commit/);
      expect(snapshot(xdg)).toEqual(before);
    }, 30_000);

    it.each([
      ['a dirty build', { dirty: true }, /dirty tree/],
      ['a missing ~/.claude.json', { claudeJson: false }, /not registered in ~\/\.claude\.json/],
      ['another installed version', { folder: '0.0.1' }, /is not version/],
    ] satisfies [string, HomeOptions, RegExp][])(
      'should refuse before writing with %s',
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

  describe('with --apply and a batch the register refuses', () => {
    let refused: Environment | undefined;
    let key: string;
    let before: ReturnType<typeof currentDecision>;
    let xdg: string;
    let result: ReturnType<typeof runReanchor>;

    beforeAll(async () => {
      const opened = await createFlowEnvironment([
        'directives-1',
        'directives-2',
        'feat-c',
        'feat-d',
      ]);
      refused = opened;
      const { g1 } = await seedRule(opened);
      for (const slug of ['feat-c', 'feat-d']) {
        await registerFlowRecord(opened, slug, decision(`${slug}.decision.same`, [anchoredIn(g1)]));
      }
      key = await poisonBatchKey(opened, 'feat-d');
      xdg = copyToXdg(opened.dataDir);
      before = currentDecision(xdg, 'feat-d', 'feat-d.decision.same');

      result = runReanchor(['--to', 'directives-2', '--apply'], xdg);
    }, 120_000);

    afterAll(async () => {
      await refused?.close();
    });

    it('should exit 1 and report the refused batch', () => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`batch refused: feat-d ${key}`);
    });

    it('should keep the other processes rewritten', () => {
      expect(result.stdout).toContain('rewrote 1 of 2 decisions');
      expect(currentDecision(xdg, 'feat-c', 'feat-c.decision.same').edges).toContainEqual(
        expect.stringMatching(/^supersedes:/),
      );
    });

    it('should leave the refused process untouched', () => {
      expect(currentDecision(xdg, 'feat-d', 'feat-d.decision.same')).toEqual(before);
    });

    it('should exit 1 on a second --apply, refusing the same batch and rewriting nothing more', () => {
      const before = snapshot(xdg);

      const again = runReanchor(['--to', 'directives-2', '--apply'], xdg);

      expect(again.status).toBe(1);
      expect(again.stderr).toContain(`batch refused: feat-d ${key}`);
      expect(again.stdout).toContain('rewrote 0 of 1 decisions');
      expect(snapshot(xdg)).toEqual(before);
    }, 30_000);
  });

  describe('with --apply on a process of 51 decisions (batches of 50 and 1)', () => {
    const COUNT = 51;
    let many: Environment | undefined;
    let written: { xdg: string; result: ReturnType<typeof runReanchor> };
    let poisoned: { key: string; result: ReturnType<typeof runReanchor> };

    beforeAll(async () => {
      const opened = await createFlowEnvironment(['directives-1', 'directives-2', 'feat-e']);
      many = opened;
      const { g1 } = await seedRule(opened);
      for (let n = 1; n <= COUNT; n++) {
        await registerFlowRecord(
          opened,
          'feat-e',
          decision(`feat-e.decision.d${n}`, [anchoredIn(g1)]),
        );
      }
      const xdg = copyToXdg(opened.dataDir);
      written = { xdg, result: runReanchor(['--to', 'directives-2', '--apply'], xdg) };
      // o lote conflitante só entra depois da cópia do apply limpo
      const key = await poisonBatchKey(opened, 'feat-e', 1);
      poisoned = {
        key,
        result: runReanchor(['--to', 'directives-2', '--apply'], copyToXdg(opened.dataDir)),
      };
    }, 240_000);

    afterAll(async () => {
      await many?.close();
    });

    it('should write both batches and count every decision', () => {
      expect(written.result.status).toBe(0);
      expect(written.result.stdout).toContain(`rewrote ${COUNT} of ${COUNT} decisions`);
      expect(written.result.stderr).not.toContain('verify failed');
      expect(batchKeys(written.xdg, 'feat-e')).toHaveLength(2);
    });

    it('should exit 1, report the refused second batch and count only the first one', () => {
      expect(poisoned.result.status).toBe(1);
      expect(poisoned.result.stderr).toContain(`batch refused: feat-e ${poisoned.key}`);
      expect(poisoned.result.stderr).not.toContain('verify failed');
      expect(poisoned.result.stdout).toContain(`rewrote ${COUNT - 1} of ${COUNT} decisions`);
    });
  });

  describe('when the invocation is refused', () => {
    it.each([
      { args: ['--to', 'directives-1'] },
      { args: ['--to', 'directives-1', '--apply'] },
      { args: ['--to', 'directives-3'] },
      { args: ['--to', 'directives-3', '--apply'] },
    ])(
      'should exit 1 and write nothing when --to is not the latest generation listed, for $args',
      ({ args }) => {
        const xdg = copyToXdg(environment.dataDir);
        const before = snapshot(xdg);

        const result = runReanchor(args, xdg);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/is not the latest directives generation/);
        expect(snapshot(xdg)).toEqual(before);
      },
      30_000,
    );

    it('should exit 2 on 0.x data', () => {
      const xdg = copyToXdg(environment.dataDir);
      fs.mkdirSync(path.join(xdg, 'hexlog', 'legacy-project'));

      const result = runReanchor(['--to', 'directives-2'], xdg);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/LEGACY_DATA/);
    }, 30_000);

    it.each([
      [[]],
      [['--apply']],
      [['--to']],
      [['--to', 'directives-x']],
      [['--to', 'directives-2', 'extra']],
      [['--to', 'directives-2', '--nope']],
    ])(
      'should exit 1 with the usage for the arguments %j',
      (args) => {
        const result = runReanchor(args, copyToXdg(environment.dataDir));

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(
          /usage: node scripts\/flow\/reanchor\.ts --to directives-<N>/,
        );
      },
      30_000,
    );
  });
});
