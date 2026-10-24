import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { composeReader } from '../src/compose.ts';
import { Name } from '../src/domain/ids.ts';
import { VERSION } from '../src/version.ts';
import { createFlowEnvironment, registerFlowRecord } from './flow-data.ts';
import { copyToXdg, createTempDir, snapshot } from './helpers.ts';
import type { Environment } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const SYNC_CLI = 'scripts/flow/sync-cli.ts';
const PROJECT = Name.parse('hexlog');
const PROCESS = 'directives-2';
const SECTION = 'Section';
// Id bem formado de um registro que não existe: o `register` recusa a relação para ele.
const UNKNOWN_GAP = `${PROCESS}:00000000-0000-7000-8000-000000000000`;

const OLD_ALPHA = 'old alpha document';
const NEW_ALPHA = 'new alpha document';
const BETA = 'beta document';
const UPTODATE = 'up to date document';

let environment: Environment;
let commit: string;
let checkout: string;

/**
 * Cópia mínima do repositório que o script aceita como checkout (o cwd tem de ser a raiz dele): o
 * código e o `package.json` num repositório git de um commit só, `node_modules` por link.
 */
function makeCheckout(): string {
  const dir = createTempDir('sync-checkout');
  for (const entry of ['scripts', 'src', 'package.json']) {
    fs.cpSync(path.join(repoRoot, entry), path.join(dir, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'));
  const git = (...args: string[]) =>
    spawnSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@test',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    );
  git('init', '--quiet');
  git('add', 'scripts', 'src', 'package.json');
  git('commit', '--quiet', '-m', 'chore: checkout');
  return dir;
}

type HomeOptions = { dirty?: boolean };

/** `HOME` temporário com o servidor registrado e o manifesto de build, no commit do `HEAD` do checkout. */
function makeHome({ dirty = false }: HomeOptions = {}): string {
  const home = createTempDir('home');
  const versionDir = path.join(home, '.local/lib/hexlog', VERSION);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(
    path.join(versionDir, 'manifest.json'),
    JSON.stringify({ version: VERSION, commit, dirty }),
  );
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { hexlog: { command: 'node', args: [path.join(versionDir, 'server.mjs')] } },
    }),
  );
  return home;
}

/** `stdin` string vai cru (JSON malformado); qualquer outro valor vai serializado. */
function runSync(
  args: string[],
  xdg: string,
  stdin: unknown = {},
  {
    home = makeHome(),
    root = checkout,
    cwd = root,
  }: { home?: string; root?: string; cwd?: string } = {},
) {
  return spawnSync(process.execPath, [path.join(root, SYNC_CLI), ...args], {
    encoding: 'utf8',
    cwd,
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    env: { ...process.env, XDG_DATA_HOME: xdg, HOME: home },
  });
}

const rule = (slug: string, text: string, closes?: string[]) => ({
  slug,
  rule: text,
  section: SECTION,
  ...(closes && { closes }),
});

const EXTRACTED = {
  alpha: [rule('r1', 'New alpha rule')],
  beta: [rule('b1', 'Beta rule')],
};

const attachments = (xdg: string): string =>
  path.join(xdg, 'hexlog', '.v1', 'hexlog', 'attachments');

/** Vigentes do tipo `directive` no processo: `target` para o texto da regra. */
function currentRules(xdg: string): Record<string, unknown> {
  const reader = composeReader({
    dataDir: path.join(xdg, 'hexlog'),
    cwd: process.cwd(),
    logger: () => undefined,
  });
  const { records } = reader.query.queryRecords({
    project: PROJECT,
    process: Name.parse(PROCESS),
    type: Name.parse('directive'),
    limit: Number.MAX_SAFE_INTEGER,
  });
  return Object.fromEntries(records.map(({ target, data }) => [target, data?.rule]));
}

async function seedDocument(slug: string, text: string, rules: Record<string, string>) {
  const { hash } = await environment.ok<{ hash: string }>('attach', { project: 'hexlog', text });
  await registerFlowRecord(environment, PROCESS, {
    type: 'doc',
    target: `directives.${slug}`,
    data: { path: `docs/directives/${slug}.md`, source: hash },
  });
  for (const [ruleSlug, ruleText] of Object.entries(rules)) {
    await registerFlowRecord(environment, PROCESS, {
      type: 'directive',
      target: `directives.${slug}.${ruleSlug}`,
      data: { rule: ruleText, section: SECTION, source: hash },
    });
  }
}

describe('scripts/flow/sync-cli.ts', () => {
  beforeAll(async () => {
    checkout = makeCheckout();
    commit = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).stdout.trim();
    fs.mkdirSync(path.join(checkout, 'docs/directives'), { recursive: true });
    for (const [slug, text] of Object.entries({
      alpha: NEW_ALPHA,
      beta: BETA,
      uptodate: UPTODATE,
      AGENTS: 'navigation',
    })) {
      fs.writeFileSync(path.join(checkout, `docs/directives/${slug}.md`), text);
    }
    environment = await createFlowEnvironment(['directives-1', PROCESS]);
    await seedDocument('alpha', OLD_ALPHA, { r1: 'Old alpha rule' });
    await seedDocument('uptodate', UPTODATE, { u1: 'Up to date rule' });
    await seedDocument('gone', 'gone document', { g1: 'Gone rule' });
  }, 60_000);

  afterAll(async () => {
    await environment.close();
  });

  describe('with check', () => {
    let xdg: string;
    let before: ReturnType<typeof snapshot>;
    let result: ReturnType<typeof runSync>;

    beforeAll(() => {
      xdg = copyToXdg(environment.dataDir);
      before = snapshot(xdg);

      result = runSync(['check', '--process', PROCESS], xdg);
    }, 30_000);

    it('should list each document as changed, new, removed or up-to-date', () => {
      expect(result.status).toBe(0);
      expect(result.stdout.split('\n').filter(Boolean)).toEqual([
        'alpha\tchanged',
        'beta\tnew',
        'gone\tremoved',
        'uptodate\tup-to-date',
      ]);
    });

    it('should leave the data untouched', () => {
      expect(snapshot(xdg)).toEqual(before);
    });
  });

  describe('with plan as a dry-run', () => {
    let xdg: string;
    let before: ReturnType<typeof snapshot>;
    let result: ReturnType<typeof runSync>;

    beforeAll(() => {
      xdg = copyToXdg(environment.dataDir);
      before = snapshot(xdg);

      result = runSync(['plan', '--process', PROCESS], xdg, EXTRACTED);
    }, 30_000);

    it('should print the batches of each document', () => {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('sync dry-run');
      expect(result.stdout).toContain('alpha\t2 records in 1 batches');
      expect(result.stdout).toContain('beta\t2 records in 1 batches');
      expect(result.stdout).toContain('gone\t1 records in 1 batches');
      expect(result.stdout).toContain('uptodate\tup-to-date');
      expect(result.stdout).toContain('install check: ok');
    });

    it('should leave the data untouched', () => {
      expect(snapshot(xdg)).toEqual(before);
    });
  });

  describe('with plan and a rule over the ceiling', () => {
    it('should refuse citing the measured size and the maximum, without writing', () => {
      const xdg = copyToXdg(environment.dataDir);
      const before = snapshot(xdg);

      const result = runSync(['plan', '--process', PROCESS], xdg, {
        ...EXTRACTED,
        alpha: [rule('r1', 'x'.repeat(401))],
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('alpha: r1: rule has size 401, max 400');
      expect(snapshot(xdg)).toEqual(before);
    }, 30_000);

    it.each([
      [
        'a slug outside the target format',
        [rule('Rule_A', 'Some rule')],
        'alpha: slug "Rule_A" is not a valid target segment',
      ],
      [
        'a repeated slug',
        [rule('r1', 'First'), rule('r1', 'Second'), rule('r1', 'Third')],
        'alpha: slug "r1" appears 3 times',
      ],
    ])(
      'should refuse %s with a message that names the slug',
      (_name, alpha, message) => {
        const xdg = copyToXdg(environment.dataDir);

        const result = runSync(['plan', '--process', PROCESS], xdg, { ...EXTRACTED, alpha });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
        expect(result.stderr).not.toContain('has size');
      },
      30_000,
    );
  });

  describe('with plan and a stdin that does not fit the documents', () => {
    it('should refuse a key that matches no document, naming it and writing nothing', () => {
      const xdg = copyToXdg(environment.dataDir);
      const before = snapshot(xdg);

      const result = runSync(['plan', '--process', PROCESS], xdg, { ...EXTRACTED, typo: [] });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('stdin key "typo" matches no document of docs/directives');
      expect(snapshot(xdg)).toEqual(before);
    }, 30_000);

    it('should not read the prototype chain for a document named constructor', () => {
      const xdg = copyToXdg(environment.dataDir);
      const file = path.join(checkout, 'docs/directives/constructor.md');
      fs.writeFileSync(file, 'constructor document');

      try {
        const result = runSync(['plan', '--process', PROCESS], xdg, EXTRACTED);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'constructor: new document without extracted rules on stdin',
        );
      } finally {
        fs.rmSync(file);
      }
    }, 30_000);

    it('should escape control characters of a stdin key before printing it', () => {
      const xdg = copyToXdg(environment.dataDir);

      const result = runSync(['plan', '--process', PROCESS], xdg, {
        ...EXTRACTED,
        'bad\u001b[31mkey': [],
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('bad\\u001b[31mkey');
      expect(result.stderr).not.toContain('\u001b');
    }, 30_000);

    it('should escape control characters of a JSON syntax error before printing it', () => {
      const xdg = copyToXdg(environment.dataDir);

      const result = runSync(['plan', '--process', PROCESS], xdg, '{"bad\u001b[31m": nope');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('stdin is not valid JSON');
      expect(result.stderr).not.toContain('\u001b');
    }, 30_000);
  });

  describe('with a cwd that is not the repository root', () => {
    it('should refuse when the cwd is another checkout than the one of the script', () => {
      const xdg = copyToXdg(environment.dataDir);

      const result = runSync(
        ['check', '--process', PROCESS],
        xdg,
        {},
        { cwd: createTempDir('elsewhere') },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not the checkout of this script');
      expect(result.stderr).toContain('run from the repository root');
    }, 30_000);

    it('should refuse with a clear message when docs/directives does not exist', () => {
      const xdg = copyToXdg(environment.dataDir);

      const result = runSync(['check', '--process', PROCESS], xdg, {}, { root: makeCheckout() });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('docs/directives not found');
      expect(result.stderr).toContain('run from the repository root');
    }, 60_000);
  });

  describe('with plan and a changed document without extracted rules', () => {
    it('should refuse naming the document, without writing', () => {
      const xdg = copyToXdg(environment.dataDir);
      const before = snapshot(xdg);

      const result = runSync(['plan', '--process', PROCESS], xdg, { alpha: EXTRACTED.alpha });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('beta: new document without extracted rules on stdin');
      expect(snapshot(xdg)).toEqual(before);
    }, 30_000);
  });

  describe('with plan --apply', () => {
    let xdg: string;
    let result: ReturnType<typeof runSync>;

    beforeAll(() => {
      xdg = copyToXdg(environment.dataDir);

      result = runSync(['plan', '--process', PROCESS, '--apply'], xdg, EXTRACTED);
    }, 60_000);

    it('should write every batch and match the reread log', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('wrote 3 of 3 batches');
    });

    it('should replace the changed rule, add the new one and drop the removed one', () => {
      expect(currentRules(xdg)).toEqual({
        'directives.alpha.r1': 'New alpha rule',
        'directives.beta.b1': 'Beta rule',
        'directives.uptodate.u1': 'Up to date rule',
      });
    });

    it('should store the attached document under the attachments folder', () => {
      const folder = attachments(xdg);

      const blobs = fs
        .readdirSync(folder)
        .map((hash) => fs.readFileSync(path.join(folder, hash), 'utf8'));

      expect(blobs).toContain(NEW_ALPHA);
    });

    it('should write nothing when applied again', () => {
      const written = snapshot(xdg);

      const again = runSync(['plan', '--process', PROCESS, '--apply'], xdg, EXTRACTED);

      expect(again.status).toBe(0);
      expect(again.stdout).toContain('alpha\tup-to-date');
      expect(snapshot(xdg)).toEqual(written);
    });
  });

  describe('with plan --apply and a refused batch', () => {
    let xdg: string;
    let result: ReturnType<typeof runSync>;

    beforeAll(() => {
      xdg = copyToXdg(environment.dataDir);

      result = runSync(['plan', '--process', PROCESS, '--apply'], xdg, {
        alpha: EXTRACTED.alpha,
        beta: [rule('b1', 'Beta rule', [UNKNOWN_GAP])],
      });
    }, 60_000);

    it('should report the refused batch and exit 1', () => {
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/^batch refused: directives-2 sync-beta-/m);
    });

    it('should keep the batches written before it and skip the ones after it', () => {
      expect(currentRules(xdg)).toEqual({
        'directives.alpha.r1': 'New alpha rule',
        'directives.gone.g1': 'Gone rule',
        'directives.uptodate.u1': 'Up to date rule',
      });
    });
  });

  it('should refuse an apply when the installed code differs and write nothing', () => {
    const xdg = copyToXdg(environment.dataDir);
    const before = snapshot(xdg);

    const result = runSync(['plan', '--process', PROCESS, '--apply'], xdg, EXTRACTED, {
      home: makeHome({ dirty: true }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('installed code check');
    expect(snapshot(xdg)).toEqual(before);
  }, 30_000);

  it('should warn the owner and exit 1 when the process does not exist', () => {
    const result = runSync(['check', '--process', 'directives-9'], copyToXdg(environment.dataDir));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stop and warn the owner');
  }, 30_000);

  it('should refuse a process that is not the latest generation', () => {
    const result = runSync(['check', '--process', 'directives-1'], copyToXdg(environment.dataDir));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not the latest directives generation');
  }, 30_000);
});
