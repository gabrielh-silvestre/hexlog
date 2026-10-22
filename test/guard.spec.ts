import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
// import default separado (não `* as fs`, já usado acima): precisa ser o mesmo objeto que
// src/installation.ts usa, para `jest.spyOn(fsDefault, 'renameSync')` interceptar de fato a
// chamada feita lá dentro (mesmo motivo documentado no comentário do `import fs` de src/adapters/fs/process-store.ts).
import fsDefault from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { quote as shellQuoteQuote } from 'shell-quote';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { detectLegacy } from '../src/adapters/fs/data-format.ts';
import { sha256hex } from '../src/domain/chain.ts';
import {
  expectedRules,
  applyGuard,
  verifyGuard,
  runRealHook,
  type ExpectedRules,
  type MissingItem,
} from '../src/guard.ts';
import {
  versionDirOf,
  readManifest,
  installArtifact,
  TOOLS_COUNT,
  registerGuard,
  writeSkillFolder,
  verifyInstallation,
  type Bundles,
} from '../src/installation.ts';
import { at, captureError, createTempDir, parseJson } from './helpers.ts';

const HOOK_TYPE = 'command';
const repoRoot = path.resolve(__dirname, '..');
const installScript = path.join(repoRoot, 'scripts/install.ts');

// Forma mínima de `~/.claude/settings.json` lida nos testes: só os campos
// que as asserções acessam, com passthrough pro resto (timeout, etc.).
const SettingsSchema = z.looseObject({
  permissions: z.looseObject({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  hooks: z.looseObject({
    PreToolUse: z.array(
      z.looseObject({
        matcher: z.string(),
        hooks: z.array(z.looseObject({ command: z.string() })),
      }),
    ),
  }),
});

// Settings "reais", sanitizados: só a forma de `permissions` e `hooks.PreToolUse`
// (~/.claude/settings.json), com um comentário pra testar preservação e a
// entrada alheia `rtk hook claude` (~/.claude/settings.json).
function buildSettingsWithRtk(home: string): string {
  return `{
  // example comment, must survive jsonc-parser edits
  "permissions": {
    "allow": ["mcp__hindsight__*"],
    "deny": ["mcp__gitnexus__cypher", "mcp__gitnexus__rename"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": "${home}/.claude/bin/harness hook worktree-guard" },
          { "type": "command", "command": "${home}/.claude/bin/harness hook commit-message-guard" }
        ]
      },
      {
        "matcher": "^Bash$",
        "hooks": [{ "type": "command", "command": "rtk hook claude" }]
      }
    ]
  }
}
`;
}

// Equivalente mínimo de `own-harness/boot/settings.template.json`
// renderizado: uma reinstalação do zero, sem nada do hexlog nem do rtk.
function buildSettingsTemplate(home: string): string {
  return `{
  "permissions": {
    "allow": ["mcp__hindsight__*"],
    "deny": ["mcp__gitnexus__cypher", "mcp__gitnexus__rename"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Agent$",
        "hooks": [{ "type": "command", "command": "${home}/.claude/bin/harness hook agent-concurrency-guard" }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": "${home}/.claude/bin/harness hook worktree-guard" },
          { "type": "command", "command": "${home}/.claude/bin/harness hook commit-message-guard" }
        ]
      }
    ]
  }
}
`;
}

// Forma real gravada pelo `claude mcp add` em `~/.claude.json` para um
// servidor stdio (confirmada em `.mcpServers.gitnexus`: `command`+`args`+`env`).
function buildFullClaudeJson(expected: ExpectedRules): string {
  return JSON.stringify({
    mcpServers: {
      hexlog: { command: expected.execPath, args: [expected.serverFile], env: {} },
    },
  });
}

function buildFullSettings(expectedForDeny: ExpectedRules, hookCommand: string): string {
  return JSON.stringify({
    permissions: {
      deny: [
        expectedForDeny.denyReadDir,
        expectedForDeny.denyRead,
        expectedForDeny.denyEdit,
        expectedForDeny.denyEditLib,
      ],
    },
    hooks: {
      PreToolUse: [
        { matcher: '^Bash$', hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] },
      ],
    },
  });
}

function noneExist(): boolean {
  return false;
}

function alwaysExists(): boolean {
  return true;
}

// Simula a semântica do hook real sem executar processo — usado nos testes
// puros de `verifyGuard`, onde só interessa a lógica dele.
function simulatedRunHook(_exec: string, _file: string, stdin: string): { status: number | null } {
  const { tool_input } = JSON.parse(stdin) as { tool_input: { command: string } };
  return { status: tool_input.command.includes('/probe') ? 2 : 0 };
}

// `expectedRules` não toca disco: um HOME e um <D> fictícios servem a todos os describes puros.
const fakeHome = '/home/test-user';
const fakeDataDir = path.join(fakeHome, '.local', 'share', 'hexlog');
const fakeExpected = expectedRules(fakeDataDir, fakeHome, '/usr/bin/node', '0.1.0');

function verifyFake(settingsText: string) {
  return verifyGuard({
    settingsText,
    claudeJsonText: buildFullClaudeJson(fakeExpected),
    expected: fakeExpected,
    exists: alwaysExists,
    runHook: simulatedRunHook,
    artifactModified: false,
  });
}

function tamperedSettings(entry: { matcher: string; type: string }): string {
  return JSON.stringify({
    permissions: {
      allow: [],
      deny: [
        fakeExpected.denyReadDir,
        fakeExpected.denyRead,
        fakeExpected.denyEdit,
        fakeExpected.denyEditLib,
      ],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: entry.matcher,
          hooks: [{ type: entry.type, command: fakeExpected.hookCommand, timeout: 10 }],
        },
      ],
    },
  });
}

const oldDataDir = '/mnt/old/data/hexlog';
const trioOf = (dataDir: string) => {
  const old = expectedRules(dataDir, fakeHome, '/usr/bin/node', '0.1.0');
  return [old.denyReadDir, old.denyRead, old.denyEdit];
};
const oldTrio = trioOf(oldDataDir);
const settingsWithDeny = (deny: string[]) =>
  JSON.stringify({ permissions: { deny } }, null, 2) + '\n';
const DenySchema = z.object({ permissions: z.object({ deny: z.array(z.string()) }) });
const denyOf = (text: string) => parseJson(DenySchema, text).permissions.deny;

describe('applyGuard', () => {
  it('should produce the same text when applied twice', () => {
    const first = applyGuard(buildSettingsTemplate(fakeHome), fakeExpected, noneExist).text;

    const second = applyGuard(first, fakeExpected, noneExist).text;

    expect(second).toBe(first);
  });

  it('should preserve the foreign rtk hook and the existing allow and deny rules', () => {
    const settings = buildSettingsWithRtk(fakeHome);

    const result = applyGuard(settings, fakeExpected, noneExist).text;

    const data = parseJson(SettingsSchema, result);
    const bashEntries = data.hooks.PreToolUse.filter(
      (entry: { matcher: string }) => entry.matcher === '^Bash$',
    );
    const commands = bashEntries.flatMap((entry: { hooks: { command: string }[] }) =>
      entry.hooks.map((h) => h.command),
    );

    expect(data.permissions.allow).toEqual(['mcp__hindsight__*']);
    expect(data.permissions.deny).toEqual(
      expect.arrayContaining(['mcp__gitnexus__cypher', 'mcp__gitnexus__rename']),
    );
    expect(commands).toContain('rtk hook claude');
    expect(commands).toContain(`${fakeHome}/.claude/bin/harness hook worktree-guard`);
    expect(commands).toContain(`${fakeHome}/.claude/bin/harness hook commit-message-guard`);
  });

  it('should replace the hook entry of an older version without duplicating it', () => {
    const oldExpected = expectedRules(fakeDataDir, fakeHome, '/usr/bin/node', '0.0.9');
    const withOldVersion = applyGuard(buildSettingsTemplate(fakeHome), oldExpected, noneExist).text;

    const result = applyGuard(withOldVersion, fakeExpected, noneExist).text;

    const data = parseJson(SettingsSchema, result);
    const hexlogEntries = data.hooks.PreToolUse.filter((entry: { hooks: { command: string }[] }) =>
      entry.hooks.some(
        (h) => typeof h.command === 'string' && h.command.includes('bash-guard.mjs'),
      ),
    );

    expect(hexlogEntries).toHaveLength(1);
    expect(at(at(hexlogEntries, 0).hooks, 0).command).toBe(fakeExpected.hookCommand);
  });

  it('should keep the result valid JSON and preserve the existing comments', () => {
    const settings = buildSettingsWithRtk(fakeHome);

    const result = applyGuard(settings, fakeExpected, noneExist).text;

    const errors: ParseError[] = [];
    parseJsonc(result, errors);

    expect(errors).toHaveLength(0);
    expect(result).toContain('// example comment');
  });

  it('should keep settings without comments parseable by JSON.parse', () => {
    const settings = buildSettingsTemplate(fakeHome);

    const result = applyGuard(settings, fakeExpected, noneExist).text;

    expect(() => {
      JSON.parse(result);
    }).not.toThrow();
  });

  it('should throw INVALID_INPUT naming /permissions/deny when deny is an object', () => {
    const settings = '{ "permissions": { "deny": {} } }';

    const error = captureError(() => applyGuard(settings, fakeExpected, noneExist));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('permissions.deny');
    expect(error.details).toEqual([
      { path: '/permissions/deny', code: 'not-array', message: error.message },
    ]);
  });

  it('should throw INVALID_INPUT naming /hooks/PreToolUse when PreToolUse is a string', () => {
    const settings = JSON.stringify({ permissions: { deny: [] }, hooks: { PreToolUse: 'x' } });

    const error = captureError(() => applyGuard(settings, fakeExpected, noneExist));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('hooks.PreToolUse');
    expect(error.details[0]?.path).toBe('/hooks/PreToolUse');
  });

  it('should repair a tampered matcher and type in place without duplicating the entry', () => {
    const tampered = tamperedSettings({ matcher: '^Edit$', type: 'prompt' });

    const repaired = applyGuard(tampered, fakeExpected, noneExist).text;

    const data = parseJson(SettingsSchema, repaired);

    expect(data.hooks.PreToolUse).toHaveLength(1);
    expect(at(data.hooks.PreToolUse, 0)).toMatchObject({
      matcher: '^Bash$',
      hooks: [{ type: HOOK_TYPE, command: fakeExpected.hookCommand, timeout: 10 }],
    });
    expect(verifyFake(repaired)).toEqual({ ok: true, missing: [] });
  });

  it('should be idempotent after repairing the matcher', () => {
    const tampered = tamperedSettings({ matcher: '^Edit$', type: 'prompt' });
    const first = applyGuard(tampered, fakeExpected, noneExist).text;

    expect(applyGuard(first, fakeExpected, noneExist).text).toBe(first);
  });

  describe('with a hexlog hook that shares its entry with foreign hooks', () => {
    const foreignHook = { type: HOOK_TYPE, command: 'foreign-hook --flag', timeout: 5 };
    const hexlogHook = { type: HOOK_TYPE, command: fakeExpected.hookCommand, timeout: 10 };

    function sharedSettings(entry: object): string {
      return `{
  // comment that must survive
  "permissions": { "deny": ${JSON.stringify([
    fakeExpected.denyReadDir,
    fakeExpected.denyRead,
    fakeExpected.denyEdit,
    fakeExpected.denyEditLib,
  ])} },
  "hooks": { "PreToolUse": [${JSON.stringify(entry)}] }
}`;
    }

    function preToolUseOf(text: string): unknown {
      return (parseJsonc(text) as { hooks: { PreToolUse: unknown } }).hooks.PreToolUse;
    }

    const misplacedEntries = [
      {
        name: 'a wider matcher',
        entry: { matcher: 'Bash|Edit|Write', hooks: [foreignHook, hexlogHook] },
      },
      { name: 'no matcher', entry: { hooks: [hexlogHook, foreignHook] } },
    ];

    it.each(misplacedEntries)(
      'should move the hexlog hook to its own ^Bash$ entry and keep the foreign entry untouched with $name',
      ({ entry }) => {
        const settings = sharedSettings(entry);

        expect(verifyFake(settings).missing).toEqual(['hook-matcher']);

        const repaired = applyGuard(settings, fakeExpected, noneExist).text;

        expect(preToolUseOf(repaired)).toEqual([
          { ...entry, hooks: [foreignHook] },
          { matcher: '^Bash$', hooks: [hexlogHook] },
        ]);
        expect(repaired).toContain('// comment that must survive');
        expect(verifyFake(repaired)).toEqual({ ok: true, missing: [] });
      },
    );

    it.each(misplacedEntries)(
      'should leave the settings alone when the guard runs again after moving the hexlog hook with $name',
      ({ entry }) => {
        const repaired = applyGuard(sharedSettings(entry), fakeExpected, noneExist).text;

        expect(applyGuard(repaired, fakeExpected, noneExist).text).toBe(repaired);
      },
    );

    it('should leave a shared entry alone when its matcher is already ^Bash$', () => {
      const settings = sharedSettings({ matcher: '^Bash$', hooks: [foreignHook, hexlogHook] });

      expect(applyGuard(settings, fakeExpected, noneExist).text).toBe(settings);
    });

    it('should fix the matcher in place when the hexlog hook is the only one in the entry', () => {
      const settings = sharedSettings({ matcher: 'Bash|Edit', hooks: [hexlogHook] });

      const repaired = applyGuard(settings, fakeExpected, noneExist).text;

      expect(preToolUseOf(repaired)).toEqual([{ matcher: '^Bash$', hooks: [hexlogHook] }]);
    });
  });

  it.each([
    { name: 'permissions is a string', settings: '{"permissions":"x"}', pointer: '/permissions' },
    { name: 'permissions is an array', settings: '{"permissions":[]}', pointer: '/permissions' },
    { name: 'permissions is null', settings: '{"permissions":null}', pointer: '/permissions' },
    {
      name: 'hooks is a string',
      settings: '{"permissions":{"deny":[]},"hooks":"x"}',
      pointer: '/hooks',
    },
    { name: 'the root is an array', settings: '[]', pointer: '' },
    { name: 'the root is null', settings: 'null', pointer: '' },
  ])('should throw INVALID_INPUT naming the path when $name', ({ settings, pointer }) => {
    const error = captureError(() => applyGuard(settings, fakeExpected, noneExist));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual([{ path: pointer, code: 'not-object', message: error.message }]);
    expect(error.message).toContain(pointer === '' ? '<root>' : pointer.slice(1));
  });

  it('should remove the three deny rules of an old <D> whose basename is hexlog', () => {
    const settings = settingsWithDeny(oldTrio);

    const result = applyGuard(settings, fakeExpected, noneExist).text;

    expect(denyOf(result)).toEqual([
      fakeExpected.denyReadDir,
      fakeExpected.denyRead,
      fakeExpected.denyEdit,
      fakeExpected.denyEditLib,
    ]);
  });

  it('should keep the rules of the current <D> when an old <D> sits next to it', () => {
    const current = trioOf(fakeDataDir);
    const settings = settingsWithDeny([...oldTrio, ...current]);

    const result = applyGuard(settings, fakeExpected, noneExist).text;

    expect(denyOf(result)).toEqual([...current, fakeExpected.denyEditLib]);
  });

  it('should keep a stray user rule even when it resembles the rules of the old <D>', () => {
    const stray = ['Read(//mnt/old/data/hexlog/secret)', 'Bash(rm:*)', 'Edit(//mnt/old/**)'];
    const settings = settingsWithDeny([...stray, ...oldTrio]);

    const result = applyGuard(settings, fakeExpected, noneExist).text;

    expect(denyOf(result)).toEqual(expect.arrayContaining(stray));
    expect(denyOf(result)).not.toContain(`Read(/${oldDataDir})`);
  });

  it('should not remove an old <D> whose basename is not hexlog', () => {
    const foreign = trioOf('/mnt/old/data/other');

    const result = applyGuard(settingsWithDeny(foreign), fakeExpected, noneExist).text;

    expect(denyOf(result)).toEqual(expect.arrayContaining(foreign));
  });

  it.each([
    { name: 'one rule', partial: oldTrio.slice(0, 1) },
    { name: 'two rules', partial: oldTrio.slice(0, 2) },
  ])('should not remove an incomplete trio of $name', ({ partial }) => {
    const settings = settingsWithDeny(partial);

    const result = applyGuard(settings, fakeExpected, noneExist).text;

    expect(denyOf(result)).toEqual(expect.arrayContaining(partial));
  });

  // O jsonc-parser não remove o último elemento quando o colchete fecha na mesma linha.
  describe('with the deny array on a single line', () => {
    const currentRules = [
      fakeExpected.denyReadDir,
      fakeExpected.denyRead,
      fakeExpected.denyEdit,
      fakeExpected.denyEditLib,
    ];
    const inline = (deny: string[]) => `{"permissions":{"deny":${JSON.stringify(deny)}}}`;

    it('should remove the old trio at the end of the array', () => {
      const settings = inline(['Bash(rm:*)', ...oldTrio]);

      const result = applyGuard(settings, fakeExpected, noneExist).text;

      expect(denyOf(result)).toEqual(['Bash(rm:*)', ...currentRules]);
    });

    it('should remove the old trio when it is the only content of the array', () => {
      const settings = inline(oldTrio);

      const result = applyGuard(settings, fakeExpected, noneExist).text;

      expect(denyOf(result)).toEqual(currentRules);
    });

    it('should remove the old trio spread among stray rules', () => {
      const [readDir, read, edit] = oldTrio;
      const settings = inline([readDir!, 'Bash(rm:*)', read!, 'Bash(ls:*)', edit!]);

      const result = applyGuard(settings, fakeExpected, noneExist).text;

      expect(denyOf(result)).toEqual(['Bash(rm:*)', 'Bash(ls:*)', ...currentRules]);
    });
  });

  it('should keep the trio of an old <D> that still exists on disk', () => {
    const settings = settingsWithDeny(oldTrio);

    const kept = applyGuard(settings, fakeExpected, (candidate) => candidate === oldDataDir).text;

    expect(denyOf(kept)).toEqual(expect.arrayContaining(oldTrio));
  });

  it('should remove the trio of an old <D> that is absent from disk', () => {
    const settings = settingsWithDeny(oldTrio);

    const removed = applyGuard(settings, fakeExpected, noneExist).text;

    expect(denyOf(removed)).not.toContain(`Read(/${oldDataDir})`);
  });

  it('should produce the same text when applied twice over an old <D> trio', () => {
    const first = applyGuard(settingsWithDeny(oldTrio), fakeExpected, noneExist).text;

    expect(applyGuard(first, fakeExpected, noneExist).text).toBe(first);
  });
});

describe('verifyGuard', () => {
  it('should report nothing missing on the settings regenerated from the template', () => {
    const regenerated = applyGuard(buildSettingsTemplate(fakeHome), fakeExpected, noneExist).text;

    const verification = verifyFake(regenerated);

    expect(verification).toEqual({ ok: true, missing: [] });
  });

  it.each([
    { item: 'deny-read-dir', rule: fakeExpected.denyReadDir },
    { item: 'deny-read', rule: fakeExpected.denyRead },
    { item: 'deny-edit', rule: fakeExpected.denyEdit },
    { item: 'deny-edit-lib', rule: fakeExpected.denyEditLib },
  ] satisfies { item: MissingItem; rule: string }[])(
    'should list $item when its deny rule is removed',
    ({ item, rule }) => {
      const full = applyGuard(buildSettingsTemplate(fakeHome), fakeExpected, noneExist).text;
      const data = parseJson(SettingsSchema, full);
      data.permissions.deny = data.permissions.deny.filter((r: string) => r !== rule);

      const verification = verifyFake(JSON.stringify(data));

      expect(verification.missing).toContain(item);
    },
  );

  it('should report hook when the hook entry is removed', () => {
    const full = applyGuard(buildSettingsTemplate(fakeHome), fakeExpected, noneExist).text;
    const data = parseJson(SettingsSchema, full);
    data.hooks.PreToolUse = data.hooks.PreToolUse.filter(
      (entry: { hooks: { command: string }[] }) =>
        !entry.hooks.some(
          (h) => typeof h.command === 'string' && h.command.includes('bash-guard.mjs'),
        ),
    );

    const verification = verifyFake(JSON.stringify(data));

    expect(verification.missing).toContain('hook');
  });

  it('should report every deny rule as missing instead of throwing when deny is not an array', () => {
    const settings = JSON.stringify({ permissions: { deny: 'x' } });

    const verification = verifyFake(settings);

    expect(verification.missing).toEqual(
      expect.arrayContaining(['deny-read-dir', 'deny-read', 'deny-edit', 'deny-edit-lib', 'hook']),
    );
  });

  it.each([
    { change: 'the matcher of the hexlog entry was changed', matcher: '^Edit$', type: HOOK_TYPE },
    { change: 'the hook type was changed', matcher: '^Bash$', type: 'prompt' },
  ])('should report hook-matcher when $change', ({ matcher, type }) => {
    const settings = tamperedSettings({ matcher, type });

    const verification = verifyFake(settings);

    expect(verification.missing).toEqual(['hook-matcher']);
  });

  it('should report only deny-edit-lib when the fourth rule is missing', () => {
    const full = applyGuard(buildSettingsTemplate(fakeHome), fakeExpected, noneExist).text;
    const data = parseJson(SettingsSchema, full);
    data.permissions.deny = data.permissions.deny.filter(
      (r: string) => r !== fakeExpected.denyEditLib,
    );

    const verification = verifyFake(JSON.stringify(data));

    expect(verification.missing).toEqual(['deny-edit-lib']);
  });

  describe('with the installed hook running for real', () => {
    // Prefixo com espaço (Critic iter3-7): o `command` do settings precisa
    // sobreviver ao ciclo `shellQuote.quote` (instalador) → `shellQuote.parse`
    // (verificação) mesmo com espaço no caminho do HOME.
    let homeWithSpace: string;
    let D: string;
    let expected: ExpectedRules;
    let realBundle: Buffer;
    const expectedVariants = new Map<string, ExpectedRules>();
    const version = '0.1.0';

    // `runRealHook` roda o hook num processo filho que herda `process.env`
    // (mesmo contrato de produção, onde o instalador roda como o usuário real):
    // pra `D` bater com o que o hook calcula, o `HOME` do processo de teste
    // precisa apontar pro `HOME` temporário enquanto este describe roda.
    const originalHome = process.env.HOME;
    const originalXdg = process.env.XDG_DATA_HOME;

    // a criação dos diretórios fica no hook, não na coleta: a coleta roda até com `-t` e vazaria (#58)
    beforeAll(() => {
      homeWithSpace = createTempDir('home ');
      D = path.join(homeWithSpace, '.local', 'share', 'hexlog');
      expected = expectedRules(D, homeWithSpace, process.execPath, version);
      process.env.HOME = homeWithSpace;
      delete process.env.XDG_DATA_HOME;

      const outdirBundle = createTempDir('guard-bundle');
      const build = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, 'test/fixtures/build-entry.ts'),
          outdirBundle,
          'bash-guard=hook/bash-guard.ts',
        ],
        { encoding: 'utf8', cwd: repoRoot },
      );
      if (build.status !== 0) {
        throw new Error(`hook build failed: ${build.stderr}`);
      }
      realBundle = fs.readFileSync(path.join(outdirBundle, 'bash-guard.mjs'));

      fs.mkdirSync(path.dirname(expected.hookFile), { recursive: true });
      fs.writeFileSync(expected.hookFile, realBundle);

      const variants: { version: string; content: string }[] = [
        { version: '0.1.0-error', content: 'this is not ( valid javascript {{{\n' },
        { version: '0.1.0-always-zero', content: 'process.exitCode = 0;\n' },
        {
          version: '0.1.0-always-two',
          content: "process.stderr.write('deny everything'); process.exitCode = 2;\n",
        },
      ];
      for (const variant of variants) {
        const variantExpected = expectedRules(D, homeWithSpace, process.execPath, variant.version);
        fs.mkdirSync(path.dirname(variantExpected.hookFile), { recursive: true });
        fs.writeFileSync(variantExpected.hookFile, variant.content);
        expectedVariants.set(variant.version, variantExpected);
      }
    });

    afterAll(() => {
      process.env.HOME = originalHome;
      if (originalXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = originalXdg;
      }
    });

    it('should report nothing missing when settings and claude.json are complete', () => {
      const settings = buildFullSettings(expected, expected.hookCommand);

      const verification = verifyGuard({
        settingsText: settings,
        claudeJsonText: buildFullClaudeJson(expected),
        expected,
        exists: fs.existsSync,
        runHook: runRealHook,
        artifactModified: false,
      });

      expect(verification).toEqual({ ok: true, missing: [] });
    });

    const functionalCases: { name: string; variantVersion: string; item: MissingItem }[] = [
      { name: 'copy with syntax error', variantVersion: '0.1.0-error', item: 'hook-not-denying' },
      {
        name: 'script that always exits 0',
        variantVersion: '0.1.0-always-zero',
        item: 'hook-not-denying',
      },
      {
        name: 'script that always exits 2',
        variantVersion: '0.1.0-always-two',
        item: 'hook-not-allowing',
      },
    ];

    it.each(functionalCases)(
      'should report $item for a $name in the real functional check',
      ({ variantVersion, item }) => {
        const variantExpected = expectedVariants.get(variantVersion)!;
        const settings = buildFullSettings(expected, variantExpected.hookCommand);

        const verification = verifyGuard({
          settingsText: settings,
          claudeJsonText: buildFullClaudeJson(expected),
          expected,
          exists: fs.existsSync,
          runHook: runRealHook,
          artifactModified: false,
        });

        expect(verification.missing).toContain(item);
      },
    );

    it('should report hook-file when the registered file does not exist', () => {
      const notInstalledExpected = expectedRules(
        D,
        homeWithSpace,
        process.execPath,
        'version-not-installed',
      );
      const settings = buildFullSettings(expected, notInstalledExpected.hookCommand);

      const verification = verifyGuard({
        settingsText: settings,
        claudeJsonText: buildFullClaudeJson(expected),
        expected: notInstalledExpected,
        exists: fs.existsSync,
        runHook: runRealHook,
        artifactModified: false,
      });

      expect(verification.missing).toContain('hook-file');
    });

    it('should report node when the registered executable does not exist', () => {
      const missingExec = path.join(homeWithSpace, 'bin-that-does-not-exist', 'node');
      const commandWithFakeExec = shellQuoteQuote([missingExec, expected.hookFile]);
      const settings = buildFullSettings(expected, commandWithFakeExec);

      const verification = verifyGuard({
        settingsText: settings,
        claudeJsonText: buildFullClaudeJson(expected),
        expected,
        exists: fs.existsSync,
        runHook: runRealHook,
        artifactModified: false,
      });

      expect(verification.missing).toContain('node');
    });

    it.each([
      { name: 'a shell command', command: 'bash -c true' },
      {
        name: 'an unrelated script run by node',
        command: `${process.execPath} /tmp/unrelated.mjs`,
      },
    ])(
      'should report hook when the command does not resolve to exactly [exec, file] under .local/lib/hexlog, as in $name',
      ({ command }) => {
        const settings = buildFullSettings(expected, command);

        const verification = verifyGuard({
          settingsText: settings,
          claudeJsonText: buildFullClaudeJson(expected),
          expected,
          exists: fs.existsSync,
          runHook: runRealHook,
          artifactModified: false,
        });

        expect(verification.missing).toContain('hook');
      },
    );

    it('should report artifact-modified when the installed bytes diverge from the manifest', () => {
      const settings = buildFullSettings(expected, expected.hookCommand);

      const verification = verifyGuard({
        settingsText: settings,
        claudeJsonText: buildFullClaudeJson(expected),
        expected,
        exists: fs.existsSync,
        runHook: runRealHook,
        artifactModified: true,
      });

      expect(verification.missing).toContain('artifact-modified');
    });

    it.each([
      { name: 'null', claudeJsonText: null },
      {
        name: 'not pointing to the installed server',
        claudeJsonText: JSON.stringify({
          mcpServers: {
            hexlog: { command: process.execPath, args: ['/wrong/path/server.mjs'] },
          },
        }),
      },
    ])('should report mcp when claude.json is $name', ({ claudeJsonText }) => {
      const settings = buildFullSettings(expected, expected.hookCommand);

      const verification = verifyGuard({
        settingsText: settings,
        claudeJsonText,
        expected,
        exists: fs.existsSync,
        runHook: runRealHook,
        artifactModified: false,
      });

      expect(verification.missing).toContain('mcp');
    });
  });
});

describe('expectedRules', () => {
  it('should build the 4 deny rules with the exact expected text', () => {
    const expected = expectedRules(fakeDataDir, fakeHome, '/usr/bin/node', '0.1.0');

    expect(expected.denyReadDir).toBe(`Read(/${fakeDataDir})`);
    expect(expected.denyRead).toBe(`Read(/${fakeDataDir}/**)`);
    expect(expected.denyEdit).toBe(`Edit(/${fakeDataDir}/**)`);
    expect(expected.denyEditLib).toBe(`Edit(/${fakeHome}/.local/lib/hexlog/**)`);
  });

  it('should prefix every rule with a double slash, never a single one', () => {
    const expected = expectedRules(fakeDataDir, fakeHome, '/usr/bin/node', '0.1.0');

    for (const rule of [
      expected.denyReadDir,
      expected.denyRead,
      expected.denyEdit,
      expected.denyEditLib,
    ]) {
      expect(rule).toMatch(/^(Read|Edit)\(\/\//);
    }
  });

  it('should keep the Read rules off .local/lib/hexlog so the installed artifact stays readable', () => {
    const expected = expectedRules(fakeDataDir, fakeHome, '/usr/bin/node', '0.1.0');

    expect(expected.denyReadDir).not.toContain('.local/lib/hexlog');
    expect(expected.denyRead).not.toContain('.local/lib/hexlog');
  });
});

describe('registerGuard', () => {
  it('should keep the trio of an old <D> that exists on disk', () => {
    const tmpHome = createTempDir('deny-old-exists');
    try {
      const existingOldD = path.join(tmpHome, 'hexlog');
      fs.mkdirSync(existingOldD);
      const settingsPath = path.join(tmpHome, 'settings.json');
      fs.writeFileSync(settingsPath, settingsWithDeny(trioOf(existingOldD)));

      const result = registerGuard({ settingsPath, expected: fakeExpected });

      expect(result).toMatchObject({ removed: [] });
      expect(denyOf(fs.readFileSync(settingsPath, 'utf8'))).toEqual(
        expect.arrayContaining(trioOf(existingOldD)),
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('should refuse a missing settings.json with an INTERNAL error and no details', () => {
    const tmpHome = createTempDir('deny-missing');
    try {
      const settingsPath = path.join(tmpHome, 'settings.json');

      expect(
        captureError(() => registerGuard({ settingsPath, expected: fakeExpected })),
      ).toMatchObject({
        code: 'INTERNAL',
        message: 'install the harness before installing hexlog',
        details: [],
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('should refuse to write an invalid settings.json and leave the original untouched', () => {
    const tmpHome = createTempDir('deny-invalid');
    try {
      const settingsPath = path.join(tmpHome, 'settings.json');
      const broken = '{"permissions":{"deny":["x"]}';
      fs.writeFileSync(settingsPath, broken);

      expect(() => registerGuard({ settingsPath, expected: fakeExpected })).toThrow(
        'refusing to write invalid settings.json',
      );
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(broken);
      expect(fs.readdirSync(tmpHome)).toEqual(['settings.json']);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('should write .bak-hexlog and settings.json through writeFileAtomic', () => {
    const tmpHome = createTempDir('deny-atomic');
    const fsyncSpy = jest.spyOn(fsDefault, 'fsyncSync');
    try {
      const settingsPath = path.join(tmpHome, 'settings.json');
      const before = settingsWithDeny(oldTrio);
      fs.writeFileSync(settingsPath, before);

      const result = registerGuard({ settingsPath, expected: fakeExpected });

      expect(result).toEqual({
        changed: true,
        removed: oldTrio,
      });
      // `writeFileAtomic` dá fsync no temporário antes do rename: uma vez por arquivo gravado.
      expect(fsyncSpy).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(`${settingsPath}.bak-hexlog`, 'utf8')).toBe(before);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(
        applyGuard(before, fakeExpected, noneExist).text,
      );
      expect(denyOf(fs.readFileSync(settingsPath, 'utf8'))).not.toContain(`Read(/${oldDataDir})`);
      expect(fs.readdirSync(tmpHome).sort()).toEqual(['settings.json', 'settings.json.bak-hexlog']);
    } finally {
      fsyncSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('should not overwrite an existing .bak-hexlog', () => {
    const tmpHome = createTempDir('deny-bak-preserved');
    try {
      const settingsPath = path.join(tmpHome, 'settings.json');
      fs.writeFileSync(`${settingsPath}.bak-hexlog`, 'backup original');
      fs.writeFileSync(settingsPath, settingsWithDeny(oldTrio));

      const result = registerGuard({ settingsPath, expected: fakeExpected });

      expect(result).toMatchObject({ changed: true });
      expect(fs.readFileSync(`${settingsPath}.bak-hexlog`, 'utf8')).toBe('backup original');
      expect(denyOf(fs.readFileSync(settingsPath, 'utf8'))).not.toContain(`Read(/${oldDataDir})`);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it.each(['EPERM', 'ENOTSUP'])(
    'should turn %s from the backup hard link into a HexlogError before writing',
    (code) => {
      const tmpHome = createTempDir('deny-bak-no-hardlink');
      const linkSpy = jest.spyOn(fsDefault, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error(`${code}: /abs/secret/path`), { code });
      });
      try {
        const settingsPath = path.join(tmpHome, 'settings.json');
        const before = settingsWithDeny(oldTrio);
        fs.writeFileSync(settingsPath, before);

        const error = captureError(() => registerGuard({ settingsPath, expected: fakeExpected }));

        expect(error).toMatchObject({
          code: 'INTERNAL',
          message: expect.stringContaining('may not support hard links'),
        });
        expect(error.message).not.toContain('/abs/secret/path');
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
        expect(fs.readdirSync(tmpHome)).toEqual(['settings.json']);
      } finally {
        linkSpy.mockRestore();
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it('should write to the symlink target and keep the link and the mode', () => {
    const tmpHome = createTempDir('deny-symlink');
    try {
      const realFile = path.join(tmpHome, 'dotfiles', 'settings.json');
      fs.mkdirSync(path.dirname(realFile));
      const before = settingsWithDeny(oldTrio);
      fs.writeFileSync(realFile, before);
      fs.chmodSync(realFile, 0o644);
      const settingsPath = path.join(tmpHome, 'settings.json');
      fs.symlinkSync(realFile, settingsPath);

      const result = registerGuard({ settingsPath, expected: fakeExpected });

      expect(result).toMatchObject({ changed: true });
      expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(realFile, 'utf8')).toBe(
        applyGuard(before, fakeExpected, noneExist).text,
      );
      expect(fs.statSync(realFile).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(`${settingsPath}.bak-hexlog`, 'utf8')).toBe(before);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // Como root, `accessSync(W_OK)` passa mesmo com `chmod 0555`, então o teste não tem o que provar.
  const itNotRoot = process.getuid?.() === 0 ? it.skip : it;

  itNotRoot('should fail before the backup when the symlink target is not writable', () => {
    const tmpHome = createTempDir('deny-symlink-readonly');
    const dotfiles = path.join(tmpHome, 'dotfiles');
    try {
      const realFile = path.join(dotfiles, 'settings.json');
      fs.mkdirSync(dotfiles);
      const before = settingsWithDeny(oldTrio);
      fs.writeFileSync(realFile, before);
      const settingsPath = path.join(tmpHome, 'settings.json');
      fs.symlinkSync(realFile, settingsPath);
      fs.chmodSync(dotfiles, 0o555);

      expect(() => registerGuard({ settingsPath, expected: fakeExpected })).toThrow(/not writable/);
      expect(fs.existsSync(`${settingsPath}.bak-hexlog`)).toBe(false);
      expect(fs.readFileSync(realFile, 'utf8')).toBe(before);
    } finally {
      fs.chmodSync(dotfiles, 0o755);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('should return an empty removed when there is no old <D>', () => {
    const tmpHome = createTempDir('deny-removed-empty');
    try {
      const settingsPath = path.join(tmpHome, 'settings.json');
      fs.writeFileSync(settingsPath, settingsWithDeny(trioOf(fakeDataDir)));

      const result = registerGuard({ settingsPath, expected: fakeExpected });

      expect(result).toEqual({ changed: true, removed: [] });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('should apply the 4 deny rules and the hook pointing to the installed versionDir', () => {
    const home = createTempDir('install-b');
    try {
      const D = path.join(home, '.local', 'share', 'hexlog');
      const expected = expectedRules(D, home, process.execPath, '0.1.0');
      const settingsPath = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, buildSettingsTemplate(home));

      const { changed } = registerGuard({ settingsPath, expected });

      const finalText = fs.readFileSync(settingsPath, 'utf8');
      const data = parseJson(SettingsSchema, finalText);

      expect(changed).toBe(true);
      expect(data.permissions.deny).toEqual(
        expect.arrayContaining([
          expected.denyReadDir,
          expected.denyRead,
          expected.denyEdit,
          expected.denyEditLib,
        ]),
      );
      expect(finalText).toContain(expected.hookCommand);
      expect(finalText).not.toContain('personal/hexlog');
      expect(fs.existsSync(`${settingsPath}.bak-hexlog`)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('should replace the hook entry of the previous version without duplicating it', () => {
    const home = createTempDir('install-d');
    try {
      const D = path.join(home, '.local', 'share', 'hexlog');
      const settingsPath = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, buildSettingsTemplate(home));
      registerGuard({
        settingsPath,
        expected: expectedRules(D, home, process.execPath, '0.1.0'),
      });

      registerGuard({
        settingsPath,
        expected: expectedRules(D, home, process.execPath, '0.2.0'),
      });

      const data = parseJson(SettingsSchema, fs.readFileSync(settingsPath, 'utf8'));
      const hexlogEntries = data.hooks.PreToolUse.filter(
        (entry: { hooks: { command: string }[] }) =>
          entry.hooks.some(
            (h) => typeof h.command === 'string' && h.command.includes('bash-guard.mjs'),
          ),
      );

      expect(hexlogEntries).toHaveLength(1);
      expect(at(at(hexlogEntries, 0).hooks, 0).command).toContain('0.2.0');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('installArtifact', () => {
  // Bundles reais construídos uma vez (esbuild custa ~1s) e reaproveitados por
  // todos os casos que não precisam de um build "diferente" de propósito.
  let realBundles: Bundles;
  let realBundlesOutdir: string;

  beforeAll(() => {
    realBundlesOutdir = createTempDir('install-build');
    const build = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/build.ts'), '--outdir', realBundlesOutdir],
      {
        encoding: 'utf8',
        cwd: repoRoot,
      },
    );
    if (build.status !== 0) {
      throw new Error(`build failed: ${build.stderr}`);
    }
    realBundles = {
      server: fs.readFileSync(path.join(realBundlesOutdir, 'server.mjs')),
      hook: fs.readFileSync(path.join(realBundlesOutdir, 'bash-guard.mjs')),
    };
  }, 30_000);

  afterAll(() => {
    fs.rmSync(realBundlesOutdir, { recursive: true, force: true });
  });

  // Roda o hook preparado (real) exatamente como `scripts/install.ts` injetaria.
  const runRealHookForInstall = (hookFile: string, stdin: string): { status: number | null } =>
    runRealHook(process.execPath, hookFile, stdin);

  /** Sobe o servidor preparado num HOME/XDG_DATA_HOME descartáveis e conta as tools anunciadas (uso real). */
  async function countRealTools(serverFile: string): Promise<number> {
    const disposableHome = createTempDir('verify');
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverFile],
        env: { HOME: disposableHome, XDG_DATA_HOME: path.join(disposableHome, 'data') },
      });
      const client = new Client({ name: 'install-test', version: '0.0.0' });
      await client.connect(transport);
      const { tools } = await client.listTools();
      await client.close();
      return tools.length;
    } finally {
      fs.rmSync(disposableHome, { recursive: true, force: true });
    }
  }

  const fakeVerifyServer = (): Promise<number> => Promise.resolve(TOOLS_COUNT);

  function runConcurrentFixture(
    home: string,
    version: string,
    variant: string,
    processId: number,
    totalProcesses: number,
    mode?: 'interleave',
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(repoRoot, 'test/fixtures/concurrent-install.ts'),
          home,
          version,
          variant,
          String(processId),
          String(totalProcesses),
          ...(mode === undefined ? [] : [mode]),
        ],
        { cwd: repoRoot },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  it('should install under <HOME>/.local/lib/hexlog/<version>/ with the 2 bundles and manifest.json using a real Client', async () => {
    const home = createTempDir('install-a');
    try {
      const result = await installArtifact({
        home,
        version: '0.1.0',
        bundles: realBundles,
        commit: 'test-commit',
        dirty: false,
        clock: () => new Date('2026-01-01T00:00:00.000Z'),
        runHook: runRealHookForInstall,
        verifyServer: countRealTools,
      });

      const versionDir = versionDirOf(home, '0.1.0');

      expect(result.action).toBe('installed');
      expect(result.versionDir).toBe(versionDir);
      expect(fs.existsSync(path.join(versionDir, 'server.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(versionDir, 'bash-guard.mjs'))).toBe(true);
      expect(readManifest(versionDir)).toEqual({
        version: '0.1.0',
        sha256: {
          server: sha256hex(realBundles.server),
          hook: sha256hex(realBundles.hook),
        },
        builtAt: '2026-01-01T00:00:00.000Z',
        commit: 'test-commit',
        dirty: false,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should decide by the installed bytes on a second run without changes, leaving settings and mtime untouched', async () => {
    const home = createTempDir('install-c');
    try {
      const args = {
        home,
        version: '0.1.0',
        bundles: realBundles,
        commit: 'c1',
        dirty: false,
        clock: () => new Date(),
        runHook: runRealHookForInstall,
        verifyServer: fakeVerifyServer,
      };
      const first = await installArtifact(args);
      const mtimeBefore = fs.statSync(first.versionDir).mtimeMs;
      const D = path.join(home, '.local', 'share', 'hexlog');
      const expected = expectedRules(D, home, process.execPath, '0.1.0');
      const settingsPath = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, buildSettingsTemplate(home));
      registerGuard({ settingsPath, expected });
      const settingsBefore = fs.readFileSync(settingsPath, 'utf8');

      const second = await installArtifact(args);

      expect(second).toEqual({
        action: 'none',
        versionDir: first.versionDir,
        manifest: first.manifest,
        warnings: [],
      });
      expect(fs.statSync(first.versionDir).mtimeMs).toBe(mtimeBefore);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should create a new version directory and keep the old one when the version changes', async () => {
    const home = createTempDir('install-d');
    try {
      const argsFor = (version: string) => ({
        home,
        version,
        bundles: realBundles,
        commit: null,
        dirty: false,
        clock: () => new Date(),
        runHook: runRealHookForInstall,
        verifyServer: fakeVerifyServer,
      });
      const first = await installArtifact(argsFor('0.1.0'));

      const second = await installArtifact(argsFor('0.2.0'));

      expect(second.action).toBe('installed');
      expect(fs.existsSync(first.versionDir)).toBe(true);
      expect(fs.existsSync(second.versionDir)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should swap atomically and warn when the same version is reinstalled with different bundles', async () => {
    const home = createTempDir('install-e');
    try {
      const argsFor = (bundles: Bundles) => ({
        home,
        version: '0.1.0',
        bundles,
        commit: 'c',
        dirty: false,
        clock: () => new Date(),
        runHook: runRealHookForInstall,
        verifyServer: fakeVerifyServer,
      });
      await installArtifact(argsFor(realBundles));
      const differentHook = Buffer.concat([
        realBundles.hook,
        Buffer.from('\n// different bytes\n'),
      ]);

      const result = await installArtifact(
        argsFor({
          server: realBundles.server,
          hook: differentHook,
        }),
      );

      expect(result.action).toBe('reinstalled');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('reinstalled with different content')]),
      );
      expect(fs.readFileSync(path.join(result.versionDir, 'bash-guard.mjs'))).toEqual(
        differentHook,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should abort without leaving the version directory when the prepared hook does not deny', async () => {
    const home = createTempDir('install-f');
    try {
      const baseArgs = {
        home,
        version: '0.1.0',
        commit: null,
        dirty: false,
        clock: () => new Date(),
      };

      await expect(
        installArtifact({
          ...baseArgs,
          bundles: realBundles,
          runHook: () => ({ status: 0 }),
          verifyServer: fakeVerifyServer,
        }),
      ).rejects.toThrow(/does not deny/);
      expect(fs.existsSync(versionDirOf(home, '0.1.0'))).toBe(false);
      expect(fs.readdirSync(path.join(home, '.local', 'lib', 'hexlog'))).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should abort without leaving the version directory when the server bundle has a dynamic require', async () => {
    const home = createTempDir('install-f');
    try {
      const baseArgs = {
        home,
        version: '0.1.0',
        commit: null,
        dirty: false,
        clock: () => new Date(),
      };
      const bundleWithDynamicRequire = Buffer.concat([
        realBundles.server,
        Buffer.from('\n// Dynamic require of "x" is not supported\n'),
      ]);

      await expect(
        installArtifact({
          ...baseArgs,
          bundles: { server: bundleWithDynamicRequire, hook: realBundles.hook },
          runHook: runRealHookForInstall,
          verifyServer: fakeVerifyServer,
        }),
      ).rejects.toThrow(/Dynamic require of/);
      expect(fs.existsSync(versionDirOf(home, '0.1.0'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should abort without leaving the version directory when the prepared server does not list every tool', async () => {
    const home = createTempDir('install-f');
    try {
      const baseArgs = {
        home,
        version: '0.1.0',
        commit: null,
        dirty: false,
        clock: () => new Date(),
      };

      await expect(
        installArtifact({
          ...baseArgs,
          bundles: realBundles,
          runHook: runRealHookForInstall,
          verifyServer: () => Promise.resolve(TOOLS_COUNT - 1),
        }),
      ).rejects.toThrow(`${TOOLS_COUNT - 1} tools`);
      expect(fs.existsSync(versionDirOf(home, '0.1.0'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should leave the installed version untouched when a later install fails the verification', async () => {
    const home = createTempDir('install-f');
    try {
      const baseArgs = {
        home,
        version: '0.1.0',
        commit: null,
        dirty: false,
        clock: () => new Date(),
      };
      const installed = await installArtifact({
        ...baseArgs,
        bundles: realBundles,
        runHook: runRealHookForInstall,
        verifyServer: fakeVerifyServer,
      });
      const hookBefore = fs.readFileSync(path.join(installed.versionDir, 'bash-guard.mjs'));

      await expect(
        installArtifact({
          ...baseArgs,
          bundles: {
            server: realBundles.server,
            hook: Buffer.concat([realBundles.hook, Buffer.from('\n// x\n')]),
          },
          runHook: () => ({ status: 0 }),
          verifyServer: fakeVerifyServer,
        }),
      ).rejects.toThrow();
      expect(fs.readFileSync(path.join(installed.versionDir, 'bash-guard.mjs'))).toEqual(
        hookBefore,
      );
      expect(fs.readdirSync(path.join(home, '.local', 'lib', 'hexlog')).sort()).toEqual(['0.1.0']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should refuse a prepared hook that denies a harmless command with an INTERNAL error and no details', async () => {
    const home = createTempDir('install-hook-allow');
    try {
      // a 1ª sonda (deny) devolve 2 e a 2ª (allow) devolve diferente de 0
      const statuses = [2, 1];

      await expect(
        installArtifact({
          home,
          version: '0.1.0',
          bundles: realBundles,
          commit: null,
          dirty: false,
          clock: () => new Date(),
          runHook: () => ({ status: statuses.shift() ?? null }),
          verifyServer: fakeVerifyServer,
        }),
      ).rejects.toMatchObject({
        code: 'INTERNAL',
        message: 'prepared hook does not allow harmless commands',
        details: [],
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should refuse a prepared server that fails to start with an INTERNAL error and no details', async () => {
    const home = createTempDir('install-server-start');
    try {
      await expect(
        installArtifact({
          home,
          version: '0.1.0',
          bundles: realBundles,
          commit: null,
          dirty: false,
          clock: () => new Date(),
          runHook: runRealHookForInstall,
          verifyServer: () => Promise.reject(new Error('boom')),
        }),
      ).rejects.toMatchObject({
        code: 'INTERNAL',
        message: 'prepared server failed to start: boom',
        details: [],
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should repair an installed artifact changed from outside on the next run', async () => {
    const home = createTempDir('install-g');
    try {
      const args = {
        home,
        version: '0.1.0',
        bundles: realBundles,
        commit: null,
        dirty: false,
        clock: () => new Date(),
        runHook: runRealHookForInstall,
        verifyServer: fakeVerifyServer,
      };
      const first = await installArtifact(args);
      const installedHookFile = path.join(first.versionDir, 'bash-guard.mjs');
      fs.writeFileSync(
        installedHookFile,
        Buffer.concat([realBundles.hook, Buffer.from('\n// modified externally\n')]),
      );

      const second = await installArtifact(args);

      expect(second.action).toBe('repaired');
      expect(second.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('installed artifact modified')]),
      );
      expect(fs.readFileSync(installedHookFile)).toEqual(realBundles.hook);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should converge when concurrent installers run the same build', async () => {
    const sameHome = createTempDir('concurrency-same');
    try {
      const [r1, r2] = await Promise.all([
        runConcurrentFixture(sameHome, '0.1.0', 'x', 1, 2),
        runConcurrentFixture(sameHome, '0.1.0', 'x', 2, 2),
      ]);

      expect([r1, r2]).toEqual([
        expect.objectContaining({ status: 0 }),
        expect.objectContaining({ status: 0 }),
      ]);
      expect(fs.readdirSync(versionDirOf(sameHome, '0.1.0')).sort()).toEqual([
        'bash-guard.mjs',
        'manifest.json',
        'server.mjs',
      ]);
    } finally {
      fs.rmSync(sameHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('should let only one win when concurrent installers run different builds', async () => {
    const differentHome = createTempDir('concurrency-different');
    try {
      const [r1, r2] = await Promise.all([
        runConcurrentFixture(differentHome, '0.1.0', 'x', 1, 2),
        runConcurrentFixture(differentHome, '0.1.0', 'y', 2, 2),
      ]);

      const sorted = [r1, r2].sort((a, b) => (a.status ?? -1) - (b.status ?? -1));

      expect(sorted).toEqual([
        expect.objectContaining({ status: 0 }),
        expect.objectContaining({ status: 1 }),
      ]);

      const loser = r1.status === 1 ? r1 : r2;

      expect(loser.stdout).toContain('at the same time');

      const versionDir = versionDirOf(differentHome, '0.1.0');

      expect(fs.readdirSync(versionDir).sort()).toEqual([
        'bash-guard.mjs',
        'manifest.json',
        'server.mjs',
      ]);
    } finally {
      fs.rmSync(differentHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('should treat ENOENT on the first renameSync as concurrency, leaving no mixed directory on a concurrent reinstall', async () => {
    const home = createTempDir('concurrency-reinstall');
    try {
      // versão já instalada antes da corrida: o primeiro renameSync de cada
      // filho (versionDir → old) só pode achar ENOENT se o outro já a moveu.
      await installArtifact({
        home,
        version: '0.1.0',
        bundles: { server: Buffer.from('initial-server'), hook: Buffer.from('initial-hook') },
        commit: null,
        dirty: false,
        clock: () => new Date(),
        runHook: (_hookFile, stdin) => ({ status: stdin.includes('/probe') ? 2 : 0 }),
        verifyServer: fakeVerifyServer,
      });

      const [r1, r2] = await Promise.all([
        runConcurrentFixture(home, '0.1.0', 'new', 1, 2),
        runConcurrentFixture(home, '0.1.0', 'new', 2, 2),
      ]);

      expect([r1, r2]).toEqual([
        expect.objectContaining({ status: 0 }),
        expect.objectContaining({ status: 0 }),
      ]);

      const versionDir = versionDirOf(home, '0.1.0');

      expect(fs.readdirSync(versionDir).sort()).toEqual([
        'bash-guard.mjs',
        'manifest.json',
        'server.mjs',
      ]);
      expect(fs.readFileSync(path.join(versionDir, 'server.mjs'), 'utf8')).toBe('server-new');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('should not share the backup directory when concurrent reinstalls run in the same millisecond', async () => {
    const home = createTempDir('concurrency-same-ms');
    try {
      await installArtifact({
        home,
        version: '0.1.0',
        bundles: { server: Buffer.from('initial-server'), hook: Buffer.from('initial-hook') },
        commit: null,
        dirty: false,
        clock: () => new Date(),
        runHook: (_hookFile, stdin) => ({ status: stdin.includes('/probe') ? 2 : 0 }),
        verifyServer: fakeVerifyServer,
      });

      // o processo 2 perde a troca; o 1 conclui e não sobra backup
      const [first, second] = await Promise.all([
        runConcurrentFixture(home, '0.1.0', 'new', 1, 2, 'interleave'),
        runConcurrentFixture(home, '0.1.0', 'new', 2, 2, 'interleave'),
      ]);

      expect(first).toEqual(expect.objectContaining({ status: 0 }));
      expect(second).toEqual(
        expect.objectContaining({
          status: 1,
          stdout: expect.stringContaining('another installation swapped'),
        }),
      );
      // os dois marcos provam que a intercalação do fixture de fato aconteceu
      expect(fs.existsSync(path.join(home, '.first-backed-up'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.second-finished'))).toBe(true);
      expect(fs.readFileSync(path.join(versionDirOf(home, '0.1.0'), 'server.mjs'), 'utf8')).toBe(
        'server-new',
      );
      expect(fs.readdirSync(path.dirname(versionDirOf(home, '0.1.0')))).toEqual(['0.1.0']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('writeSkillFolder', () => {
  /** Pasta de origem sintética com um `SKILL.md` (e, se passado, um arquivo extra em `references/`). */
  function buildSrcDir(skillText: string, extraFile?: { path: string; text: string }): string {
    const srcDir = createTempDir('skill-src');
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), skillText);
    if (extraFile) {
      fs.mkdirSync(path.join(srcDir, path.dirname(extraFile.path)), { recursive: true });
      fs.writeFileSync(path.join(srcDir, extraFile.path), extraFile.text);
    }
    return srcDir;
  }

  it('should copy SKILL.md and references/ to <home>/.claude/skills/<name>/', () => {
    const home = createTempDir('skill-a');
    const srcDir = buildSrcDir('# hexlog skill\n', {
      path: 'references/guide.md',
      text: '# guide\n',
    });
    try {
      writeSkillFolder(home, 'hexlog', srcDir);

      const skillDir = path.join(home, '.claude', 'skills', 'hexlog');

      expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('# hexlog skill\n');
      expect(fs.readFileSync(path.join(skillDir, 'references', 'guide.md'), 'utf8')).toBe(
        '# guide\n',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should leave the file identical when installed twice in a row', () => {
    const home = createTempDir('skill-b');
    const srcDir = buildSrcDir('# hexlog skill\n');
    try {
      const skillFile = path.join(home, '.claude', 'skills', 'hexlog', 'SKILL.md');
      writeSkillFolder(home, 'hexlog', srcDir);

      writeSkillFolder(home, 'hexlog', srcDir);

      expect(fs.readFileSync(skillFile, 'utf8')).toBe('# hexlog skill\n');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should overwrite a hand-edited file with the canonical one without creating a .bak', () => {
    const home = createTempDir('skill-c');
    const srcDir = buildSrcDir('# hexlog skill\n');
    try {
      const skillDir = path.join(home, '.claude', 'skills', 'hexlog');
      const skillFile = path.join(skillDir, 'SKILL.md');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillFile, 'editado à mão');

      writeSkillFolder(home, 'hexlog', srcDir);

      expect(fs.readFileSync(skillFile, 'utf8')).toBe('# hexlog skill\n');
      expect(fs.existsSync(`${skillFile}.bak-hexlog`)).toBe(false);
      expect(fs.readdirSync(skillDir)).toEqual(['SKILL.md']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should remove an orphaned references/ file when reinstalling from a srcDir without it', () => {
    const home = createTempDir('skill-d');
    const srcDirV1 = buildSrcDir('# hexlog skill v1\n', {
      path: 'references/old-guide.md',
      text: '# old guide\n',
    });
    const srcDirV2 = buildSrcDir('# hexlog skill v2\n');
    try {
      writeSkillFolder(home, 'hexlog', srcDirV1);
      const orphanFile = path.join(
        home,
        '.claude',
        'skills',
        'hexlog',
        'references',
        'old-guide.md',
      );

      expect(fs.existsSync(orphanFile)).toBe(true);

      writeSkillFolder(home, 'hexlog', srcDirV2);

      expect(fs.existsSync(orphanFile)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDirV1, { recursive: true, force: true });
      fs.rmSync(srcDirV2, { recursive: true, force: true });
    }
  });

  it('should keep the previous dstDir content intact when srcDir does not exist and cpSync fails', () => {
    const home = createTempDir('skill-e');
    const srcDir = buildSrcDir('# hexlog skill\n');
    const missingSrcDir = path.join(os.tmpdir(), 'hexlog-skill-src-does-not-exist');
    try {
      writeSkillFolder(home, 'hexlog', srcDir);
      const skillFile = path.join(home, '.claude', 'skills', 'hexlog', 'SKILL.md');

      expect(() => writeSkillFolder(home, 'hexlog', missingSrcDir)).toThrow();

      expect(fs.readFileSync(skillFile, 'utf8')).toBe('# hexlog skill\n');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should keep the previous dstDir content when the 2nd renameSync fails mid-swap', () => {
    const home = createTempDir('skill-g');
    const srcDirV1 = buildSrcDir('# hexlog skill v1\n');
    const srcDirV2 = buildSrcDir('# hexlog skill v2\n');
    const originalRenameSync = fsDefault.renameSync;
    try {
      writeSkillFolder(home, 'hexlog', srcDirV1);
      const skillFile = path.join(home, '.claude', 'skills', 'hexlog', 'SKILL.md');
      jest
        .spyOn(fsDefault, 'renameSync')
        // 1º rename (dstDir -> old) passa de verdade; 2º (tmp -> dstDir) é o que falha.
        .mockImplementationOnce((...args) => originalRenameSync(...args))
        .mockImplementationOnce(() => {
          throw new Error('boom: simulated 2nd renameSync failure');
        });

      expect(() => writeSkillFolder(home, 'hexlog', srcDirV2)).toThrow('boom');

      expect(fs.readFileSync(skillFile, 'utf8')).toBe('# hexlog skill v1\n');
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDirV1, { recursive: true, force: true });
      fs.rmSync(srcDirV2, { recursive: true, force: true });
    }
  });

  it('should sweep the legacy skills/<name>.tmp-<pid> and .old-<pid> leftovers without touching other folders', () => {
    const home = createTempDir('skill-legacy');
    const srcDir = buildSrcDir('# hexlog skill\n');
    try {
      const skillsDir = path.join(home, '.claude', 'skills');
      const kept = ['hexlog.old-notes', 'other.tmp-123'];
      for (const leftover of ['hexlog.tmp-123', 'hexlog.old-123', ...kept]) {
        fs.mkdirSync(path.join(skillsDir, leftover), { recursive: true });
      }

      writeSkillFolder(home, 'hexlog', srcDir);

      expect(fs.readdirSync(skillsDir).sort()).toEqual(['hexlog', ...kept]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should keep, in the legacy sweep, entries whose suffix is not tmp-/old- plus digits', () => {
    const home = createTempDir('skill-legacy-suffix');
    const srcDir = buildSrcDir('# hexlog skill\n');
    try {
      const skillsDir = path.join(home, '.claude', 'skills');
      const kept = [
        'hexlog.tmp-',
        'hexlog.tmp-12a',
        'hexlog.old-1-2',
        'hexlog.bak-123',
        'hexlog-tmp-123',
      ];
      for (const leftover of ['hexlog.tmp-7', 'hexlog.old-42', ...kept]) {
        fs.mkdirSync(path.join(skillsDir, leftover), { recursive: true });
      }

      writeSkillFolder(home, 'hexlog', srcDir);

      expect(fs.readdirSync(skillsDir).sort()).toEqual(['hexlog', ...kept].sort());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should handle, in the legacy sweep, a skill name with regex metacharacters', () => {
    const home = createTempDir('skill-legacy-meta');
    const srcDir = buildSrcDir('# c++ skill\n');
    try {
      const skillsDir = path.join(home, '.claude', 'skills');
      const kept = ['c++.old-notes', 'cc.tmp-123', 'c+(a[b.tmp-9x'];
      for (const leftover of ['c++.tmp-123', 'c++.old-123', 'c+(a[b.old-5', ...kept]) {
        fs.mkdirSync(path.join(skillsDir, leftover), { recursive: true });
      }

      writeSkillFolder(home, 'c++', srcDir);
      writeSkillFolder(home, 'c+(a[b', srcDir);

      expect(fs.readdirSync(skillsDir).sort()).toEqual(['c++', 'c+(a[b', ...kept].sort());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should run the legacy sweep after the swap and ignore an rmSync failure', () => {
    const home = createTempDir('skill-legacy-eacces');
    const srcDir = buildSrcDir('# hexlog skill v2\n');
    const originalRmSync = fsDefault.rmSync;
    try {
      const skillsDir = path.join(home, '.claude', 'skills');
      fs.mkdirSync(path.join(skillsDir, 'hexlog.tmp-1'), { recursive: true });
      fs.mkdirSync(path.join(skillsDir, 'hexlog.old-2'), { recursive: true });
      jest.spyOn(fsDefault, 'rmSync').mockImplementation((target, options) => {
        if (String(target).endsWith('hexlog.tmp-1')) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        originalRmSync(target, options);
      });

      expect(() => writeSkillFolder(home, 'hexlog', srcDir)).not.toThrow();

      expect(fs.readFileSync(path.join(skillsDir, 'hexlog', 'SKILL.md'), 'utf8')).toBe(
        '# hexlog skill v2\n',
      );
      expect(fs.readdirSync(skillsDir).sort()).toEqual(['hexlog', 'hexlog.tmp-1']);
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should ignore, in the orphan sweep, a failure to list the temporary directory', () => {
    const home = createTempDir('skill-orphans-unreadable');
    const srcDir = buildSrcDir('# hexlog skill v2\n');
    const originalReaddirSync = fsDefault.readdirSync.bind(fsDefault) as (
      dir: fs.PathLike,
    ) => string[];
    try {
      const claudeDir = path.join(fs.realpathSync(home), '.claude');
      const orphan = `.hexlog-skill-hexlog.tmp-${spawnSync(process.execPath, ['-e', '']).pid}`;
      fs.mkdirSync(path.join(claudeDir, orphan), { recursive: true });
      jest.spyOn(fsDefault, 'readdirSync').mockImplementation(((dir: fs.PathLike) => {
        if (String(dir) === claudeDir) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return originalReaddirSync(dir);
      }) as typeof fsDefault.readdirSync);

      expect(() => writeSkillFolder(home, 'hexlog', srcDir)).not.toThrow();

      jest.restoreAllMocks();

      expect(fs.readFileSync(path.join(claudeDir, 'skills', 'hexlog', 'SKILL.md'), 'utf8')).toBe(
        '# hexlog skill v2\n',
      );
      expect(fs.readdirSync(claudeDir).sort()).toEqual([orphan, 'skills'].sort());
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should remove, in the orphan sweep, temporaries of a dead pid and keep live, foreign and non-numeric ones', () => {
    const home = createTempDir('skill-orphans');
    const srcDir = buildSrcDir('# hexlog skill\n');
    try {
      const claudeDir = path.join(home, '.claude');
      const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
      const orphans = [
        `.hexlog-skill-hexlog.tmp-${deadPid}`,
        `.hexlog-skill-hexlog.old-${deadPid}`,
      ];
      const kept = [
        `.hexlog-skill-hexlog.tmp-${process.ppid}`,
        `.hexlog-skill-hexlog.old-${process.ppid}`,
        `.hexlog-skill-hexlog.old-${deadPid}x`,
        `.hexlog-skill-other.tmp-${deadPid}`,
      ];
      for (const leftover of [...orphans, ...kept]) {
        fs.mkdirSync(path.join(claudeDir, leftover), { recursive: true });
      }

      writeSkillFolder(home, 'hexlog', srcDir);

      const remaining = fs
        .readdirSync(claudeDir)
        .filter((entry) => entry.startsWith('.hexlog-skill-'));

      expect(remaining.sort()).toEqual([...kept].sort());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should leave no temporary in skills/ or .claude/ and keep the previous skill when the 2nd renameSync fails', () => {
    const home = createTempDir('skill-h');
    const srcDirV1 = buildSrcDir('# hexlog skill v1\n');
    const srcDirV2 = buildSrcDir('# hexlog skill v2\n');
    const originalRenameSync = fsDefault.renameSync;
    try {
      writeSkillFolder(home, 'hexlog', srcDirV1);
      jest
        .spyOn(fsDefault, 'renameSync')
        .mockImplementationOnce((...args) => originalRenameSync(...args))
        .mockImplementationOnce(() => {
          throw new Error('boom: simulated 2nd renameSync failure');
        });

      expect(() => writeSkillFolder(home, 'hexlog', srcDirV2)).toThrow('boom');

      expect(fs.readdirSync(path.join(home, '.claude', 'skills'))).toEqual(['hexlog']);
      expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['skills']);
      expect(
        fs.readFileSync(path.join(home, '.claude', 'skills', 'hexlog', 'SKILL.md'), 'utf8'),
      ).toBe('# hexlog skill v1\n');
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDirV1, { recursive: true, force: true });
      fs.rmSync(srcDirV2, { recursive: true, force: true });
    }
  });

  it('should keep the temporaries beside the target and avoid EXDEV when skills/ is a link to another filesystem', () => {
    const home = createTempDir('skill-link');
    const elsewhere = createTempDir('skill-link-target');
    const srcDir = buildSrcDir('# hexlog skill\n');
    const originalRenameSync = fsDefault.renameSync;
    try {
      // `skills/` aponta para fora do HOME: simula o outro filesystem (dotfiles, mount).
      const realSkills = path.join(elsewhere, 'skills');
      fs.mkdirSync(realSkills);
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.symlinkSync(realSkills, path.join(home, '.claude', 'skills'));
      const realHome = fs.realpathSync(home);
      const deviceOf = (target: string): string =>
        fs.realpathSync(path.dirname(target)).startsWith(realHome) ? 'home' : 'elsewhere';
      jest.spyOn(fsDefault, 'renameSync').mockImplementation((from, to) => {
        if (deviceOf(String(from)) !== deviceOf(String(to))) {
          throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
            code: 'EXDEV',
          });
        }
        originalRenameSync(from, to);
      });

      writeSkillFolder(home, 'hexlog', srcDir);

      expect(fs.readFileSync(path.join(realSkills, 'hexlog', 'SKILL.md'), 'utf8')).toBe(
        '# hexlog skill\n',
      );
      expect(fs.readdirSync(realSkills)).toEqual(['hexlog']);
      expect(fs.readdirSync(elsewhere)).toEqual(['skills']);
      expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['skills']);
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should fall back to <home>/.claude for the temporaries when the parent of the link target is not writable', () => {
    const home = createTempDir('skill-link-ro');
    const elsewhere = createTempDir('skill-link-ro-target');
    const srcDir = buildSrcDir('# hexlog skill\n');
    const originalRenameSync = fsDefault.renameSync;
    const originalAccessSync = fsDefault.accessSync;
    try {
      const realSkills = path.join(elsewhere, 'skills');
      fs.mkdirSync(realSkills);
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.symlinkSync(realSkills, path.join(home, '.claude', 'skills'));
      const realElsewhere = fs.realpathSync(elsewhere);
      // Simula o pai do alvo sem permissão de escrita sem depender de chmod (que root ignora).
      jest.spyOn(fsDefault, 'accessSync').mockImplementation((target, mode) => {
        if (String(target) === realElsewhere) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        originalAccessSync(target, mode);
      });
      const tempParents: string[] = [];
      jest.spyOn(fsDefault, 'renameSync').mockImplementation((from, to) => {
        if (path.basename(String(from)).startsWith('.hexlog-skill-')) {
          tempParents.push(path.dirname(String(from)));
        }
        originalRenameSync(from, to);
      });

      writeSkillFolder(home, 'hexlog', srcDir);

      expect(tempParents).toEqual([path.join(fs.realpathSync(home), '.claude')]);
      expect(fs.readFileSync(path.join(realSkills, 'hexlog', 'SKILL.md'), 'utf8')).toBe(
        '# hexlog skill\n',
      );
      expect(fs.readdirSync(elsewhere)).toEqual(['skills']);
      expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['skills']);
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('should reject a name with "/", "..", "." or empty before touching the filesystem', () => {
    const home = createTempDir('skill-f');
    const srcDir = buildSrcDir('# hexlog skill\n');
    try {
      expect(() => writeSkillFolder(home, '../escape', srcDir)).toThrow();
      expect(() => writeSkillFolder(home, 'a/b', srcDir)).toThrow();
      expect(() => writeSkillFolder(home, '.', srcDir)).toThrow();
      expect(() => writeSkillFolder(home, '..', srcDir)).toThrow();
      expect(() => writeSkillFolder(home, '', srcDir)).toThrow();
      expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });
});

/** Roda `scripts/install.ts` como processo real, com `HOME` e `<D>` (via `XDG_DATA_HOME`) descartáveis. */
function runInstaller(home: string, D: string, args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [installScript, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: path.dirname(D),
      HEXLOG_REGISTER_MCP: path.join(repoRoot, 'test/fixtures/fake-mcp-install.ts'),
    },
  });
}

/** Instala o baseline real (processo) num HOME descartável: o `--check` e o `verifyInstallation` partem dele. */
function installBaseline(): { home: string; D: string; version: string } {
  const version = (
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const home = createTempDir('b3');
  // Fixa o <D> no HOME temporário: um XDG_DATA_HOME herdado com dado 0.x faria o instalador sair 2.
  const D = path.join(home, '.local', 'share', 'hexlog');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), buildSettingsTemplate(home));

  const installation = runInstaller(home, D, []);
  if (installation.status !== 0) {
    throw new Error(
      `real baseline installation failed: ${installation.stderr}\n${installation.stdout}`,
    );
  }
  return { home, D, version };
}

describe('verifyInstallation', () => {
  let home: string;
  let D: string;
  let version: string;

  beforeAll(() => {
    ({ home, D, version } = installBaseline());
  }, 30_000);

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('should warn artifact-outdated and keep the exit when the current build differs from the manifest and the installed bytes are intact', () => {
    // Chamada direta (sem subprocesso): `runRealHook` herda `process.env` do
    // processo de teste, então o hook precisa enxergar o mesmo HOME temporário
    // usado pra montar `expected` — mesmo motivo do describe de `verifyGuard`
    // com o hook real.
    const originalHome = process.env.HOME;
    const originalXdg = process.env.XDG_DATA_HOME;
    process.env.HOME = home;
    delete process.env.XDG_DATA_HOME;
    try {
      const versionDir = versionDirOf(home, version);
      const manifest = readManifest(versionDir)!;
      const expected = expectedRules(D, home, process.execPath, version);
      const settingsText = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
      const claudeJsonText = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
      // Simula um build atual diferente do que gerou o manifesto, sem alterar a working tree real.
      const bundlesSimulatingNewBuild: Bundles = {
        server: Buffer.from('server-from-a-future-build'),
        hook: fs.readFileSync(expected.hookFile),
      };

      const result = verifyInstallation({
        home,
        version,
        execPath: process.execPath,
        D,
        skillNames: [],
        currentBundles: bundlesSimulatingNewBuild,
        settingsText,
        claudeJsonText,
        runHook: runRealHook,
        currentHead: 'test-simulated-head',
      });

      expect(result.exit).toBe(0);
      expect(result.warnings.some((w) => w.startsWith('artifact-outdated'))).toBe(true);
      expect(result.warnings.some((w) => w.includes(String(manifest.commit)))).toBe(true);
      expect(result.warnings.some((w) => w.includes('test-simulated-head'))).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      if (originalXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = originalXdg;
      }
    }
  });
});

describe('scripts/install.ts', () => {
  const legacyFixture = path.join(repoRoot, 'test/fixtures/legacy-0x');
  const strayRule = 'Bash(rm:*)';

  // `<D>` fica sob o XDG_DATA_HOME fixado no HOME temporário: nunca o dado real do usuário.
  function createInstallHome(prefix: string): { home: string; D: string } {
    const home = createTempDir(prefix);
    return { home, D: path.join(home, '.local', 'share', 'hexlog') };
  }

  function snapshotTree(root: string): Record<string, string | null> {
    return Object.fromEntries(
      fs
        .readdirSync(root, { recursive: true })
        .map(String)
        .sort()
        .map((relative) => {
          const absolute = path.join(root, relative);
          return [
            relative,
            fs.statSync(absolute).isDirectory() ? null : fs.readFileSync(absolute).toString('hex'),
          ];
        }),
    );
  }

  const packagesOf = (D: string): string[] => fs.readdirSync(path.join(D, 'archive')).sort();

  it('should abort before writing settings.json when the skill swap fails', () => {
    const home = createTempDir('b3a');
    const D = path.join(home, '.local', 'share', 'hexlog');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const template = buildSettingsTemplate(home);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, template);
    // `skills` como arquivo comum: o mkdir de writeSkillFolder falha com EEXIST.
    fs.writeFileSync(path.join(home, '.claude', 'skills'), 'not a directory');
    try {
      const result = runInstaller(home, D, []);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('EEXIST');
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(template);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('should exit 1 with the message on stderr and write nothing for an unknown argument', () => {
    const disposableHome = createTempDir('b3-unknown-arg');
    try {
      const result = runInstaller(disposableHome, path.join(disposableHome, 'data', 'hexlog'), [
        '--archive0x',
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unknown argument: --archive0x');
      expect(fs.readdirSync(disposableHome)).toEqual([]);
    } finally {
      fs.rmSync(disposableHome, { recursive: true, force: true });
    }
  });

  describe('with --check', () => {
    let home: string;
    let D: string;
    let version: string;

    beforeAll(() => {
      ({ home, D, version } = installBaseline());
    }, 30_000);

    afterAll(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });

    function runCheck(opts: { cwd?: string } = {}): { status: number | null; stdout: string } {
      const { status, stdout } = runInstaller(home, D, ['--check'], opts.cwd);
      return { status, stdout };
    }

    it('should exit 0 without artifact-modified or artifact-outdated on a complete installation', () => {
      const { status, stdout } = runCheck();

      expect(status).toBe(0);
      expect(stdout).not.toContain('artifact-modified');
      expect(stdout).not.toContain('artifact-outdated');
    }, 15_000);

    it('should report hook-file and exit 1 when the version directory is removed', () => {
      const versionDir = versionDirOf(home, version);
      const backup = `${versionDir}.backup-test`;
      fs.renameSync(versionDir, backup);
      try {
        const { status, stdout } = runCheck();

        expect(status).toBe(1);
        expect(stdout).toContain('hook-file');
      } finally {
        fs.renameSync(backup, versionDir);
      }
    }, 15_000);

    it('should report skill-file:<name> and exit 1 when a skill directory is removed', () => {
      const name = at(
        fs
          .readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
        0,
      );
      const skillDir = path.join(home, '.claude', 'skills', name);
      const backup = `${skillDir}.backup-test`;
      fs.renameSync(skillDir, backup);
      try {
        const { status, stdout } = runCheck();

        expect(status).toBe(1);
        expect(stdout).toContain(`skill-file:${name}`);
      } finally {
        fs.renameSync(backup, skillDir);
      }
    }, 15_000);

    it('should give the same result when run from another cwd', () => {
      const fromRepo = runCheck();

      const fromOtherCwd = runCheck({ cwd: os.tmpdir() });

      expect(fromOtherCwd.status).toBe(fromRepo.status);
      expect(fromOtherCwd.stdout).toBe(fromRepo.stdout);
    }, 15_000);

    it('should still verify without aborting raw when <D> is unreadable with ENOTDIR', () => {
      const blocker = path.join(home, 'not-a-dir');
      fs.writeFileSync(blocker, '');

      const result = runInstaller(home, path.join(blocker, 'hexlog'), ['--check']);

      expect(result.stderr).not.toContain('ENOTDIR');
      expect(result.stdout).toContain('missing:');
    }, 15_000);
  });

  describe('with 0.x data', () => {
    it('should exit 2, list what it would archive and leave <D> intact without a flag', () => {
      const { home, D } = createInstallHome('f6-lista');
      fs.cpSync(legacyFixture, D, { recursive: true });
      const before = snapshotTree(D);

      const result = runInstaller(home, D, []);

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('rerun with --archive-0x');
      expect(result.stdout).toContain('file: alpha/main/events.jsonl');
      expect(result.stdout).toContain('dir: alpha');
      expect(snapshotTree(D)).toEqual(before);
      expect(fs.readdirSync(home)).toEqual(['.local']);
    }, 30_000);

    it('should exit 1 without installing or deleting when a 0.x lock is held by a live process with --archive-0x', () => {
      const { home, D } = createInstallHome('f6-archive-lock');
      fs.cpSync(legacyFixture, D, { recursive: true });
      const lockDir = path.join(D, 'alpha', 'main', 'events.jsonl.lock');
      fs.mkdirSync(lockDir);
      // o pid do processo de teste está vivo enquanto o instalador roda
      fs.writeFileSync(path.join(lockDir, 'holder'), `${process.pid}-deadbeef`);
      const before = snapshotTree(D);

      const result = runInstaller(home, D, ['--archive-0x']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('lock is held by a live process');
      expect(snapshotTree(D)).toEqual(before);
      expect(fs.readdirSync(home)).toEqual(['.local']);
    }, 30_000);

    it('should only verify and write nothing with --check --archive-0x', () => {
      const { home, D } = createInstallHome('f6-archive-check');
      fs.cpSync(legacyFixture, D, { recursive: true });
      const before = snapshotTree(home);

      const result = runInstaller(home, D, ['--check', '--archive-0x']);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('missing:');
      expect(snapshotTree(home)).toEqual(before);
    }, 30_000);
  });

  describe('with 0.x data archived by --archive-0x', () => {
    let home: string;
    let D: string;
    let version: string;
    let oldDenyRules: string[];
    let first: ReturnType<typeof runInstaller>;

    // uma só instalação (build + servidor real) alimenta os testes do grupo
    beforeAll(() => {
      version = parseJson(
        z.looseObject({ version: z.string() }),
        fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
      ).version;
      ({ home, D } = createInstallHome('f6-archive'));
      fs.cpSync(legacyFixture, D, { recursive: true });
      // <D> antigo que não existe em disco: só então o trio dele pode sair
      const old = expectedRules(
        path.join(home, 'old-data', 'hexlog'),
        home,
        process.execPath,
        version,
      );
      oldDenyRules = [old.denyReadDir, old.denyRead, old.denyEdit];
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { deny: [strayRule, ...oldDenyRules] } }),
      );

      first = runInstaller(home, D, ['--archive-0x']);
    }, 60_000);

    it('should archive the 0.x data into <D>/archive and then install 1.0', () => {
      expect(first.status).toBe(0);
      expect(first.stdout).toMatch(/archived \d+ file\(s\) of 0\.x data into .*hexlog-0x-.*\.tar/);
      expect(first.stdout).toContain(`hexlog ${version}: `);
      expect(detectLegacy(D)).toEqual([]);
      expect(packagesOf(D)).toHaveLength(1);
      expect(fs.existsSync(path.join(versionDirOf(home, version), 'server.mjs'))).toBe(true);
    });

    it('should print one removed deny rule line per rule of the old <D> and keep the stray one', () => {
      const printed = first.stdout
        .split('\n')
        .filter((line) => line.includes('removed deny rule:'));
      const deny = denyOf(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));

      expect(printed).toEqual(oldDenyRules.map((rule) => `  removed deny rule: ${rule}`));
      expect(deny).toContain(strayRule);

      for (const rule of oldDenyRules) expect(deny).not.toContain(rule);
    });

    it('should not archive again and should reinstall without error on a second run with --archive-0x', () => {
      const packagesBefore = packagesOf(D);

      const second = runInstaller(home, D, ['--archive-0x']);

      expect(second.status).toBe(0);
      expect(second.stdout).not.toContain('archived');
      expect(second.stdout).not.toContain('removed deny rule');
      expect(packagesOf(D)).toEqual(packagesBefore);
    }, 60_000);
  });
});
