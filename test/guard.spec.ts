import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
// Import padrão: precisa ser o mesmo objeto que src/installation.ts usa, para o `jest.spyOn(fs, ...)`
// interceptar de fato a chamada feita lá dentro (mesmo motivo documentado no comentário do
// `import fs` de src/adapters/fs/process-store.ts).
import fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { quote as shellQuoteQuote } from 'shell-quote';
import { z } from 'zod';
import {
  expectedRules,
  applyGuard,
  verifyGuard,
  runRealHook,
  type ExpectedRules,
  type MissingItem,
} from '../src/guard.ts';
import { registerGuard } from '../src/installation.ts';
import { at, captureError, createTempDir, parseJson } from './helpers.ts';
import { buildSettingsTemplate, denyOf, repoRoot, useHome } from './install-helpers.ts';

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

type HookEntry = { hooks: { command: string }[] };

/** As entradas de `PreToolUse` que registram o hook do hexlog. */
const hexlogEntriesOf = (data: z.infer<typeof SettingsSchema>) =>
  data.hooks.PreToolUse.filter((entry: HookEntry) =>
    entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes('bash-guard.mjs')),
  );

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

// Forma real gravada pelo `claude mcp add` em `~/.claude.json` para um
// servidor stdio (confirmada em `.mcpServers.gitnexus`: `command`+`args`+`env`).
function buildFullClaudeJson(expected: ExpectedRules): string {
  return JSON.stringify({
    mcpServers: {
      hexlog: { command: expected.execPath, args: [expected.serverFile], env: {} },
    },
  });
}

/** As 4 regras de deny que o guard registra, na ordem do `ExpectedRules`. */
const denyRulesOf = (expected: ExpectedRules): string[] => [
  expected.denyReadDir,
  expected.denyRead,
  expected.denyEdit,
  expected.denyEditLib,
];

function buildFullSettings(expectedForDeny: ExpectedRules, hookCommand: string): string {
  return JSON.stringify({
    permissions: { deny: denyRulesOf(expectedForDeny) },
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
    permissions: { allow: [], deny: denyRulesOf(fakeExpected) },
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

const foreignHook = { type: 'command', command: 'foreign-hook --flag', timeout: 5 };
const hexlogHook = { type: 'command', command: fakeExpected.hookCommand, timeout: 10 };

/** Settings cuja única entrada de `PreToolUse` é `entry`, com as regras de deny corretas e um comentário. */
function sharedSettings(entry: object): string {
  return `{
  // comment that must survive
  "permissions": { "deny": ${JSON.stringify(denyRulesOf(fakeExpected))} },
  "hooks": { "PreToolUse": [${JSON.stringify(entry)}] }
}`;
}

const misplacedEntries = [
  {
    name: 'a wider matcher',
    entry: { matcher: 'Bash|Edit|Write', hooks: [foreignHook, hexlogHook] },
  },
  { name: 'no matcher', entry: { hooks: [hexlogHook, foreignHook] } },
];

const oldDataDir = '/mnt/old/data/hexlog';
const trioOf = (dataDir: string) => {
  const old = expectedRules(dataDir, fakeHome, '/usr/bin/node', '0.1.0');
  return [old.denyReadDir, old.denyRead, old.denyEdit];
};
const oldTrio = trioOf(oldDataDir);
const settingsWithDeny = (deny: string[]) =>
  JSON.stringify({ permissions: { deny } }, null, 2) + '\n';

describe('applyGuard', () => {
  it.each([
    ['the settings template', buildSettingsTemplate(fakeHome)],
    ['a repaired matcher and type', tamperedSettings({ matcher: '^Edit$', type: 'prompt' })],
    ...misplacedEntries.map(({ name, entry }) => [
      `a hexlog hook moved out of ${name}`,
      sharedSettings(entry),
    ]),
    ['an old <D> trio', settingsWithDeny(oldTrio)],
  ] as [string, string][])(
    'should leave the settings alone when the guard runs again over %s',
    (_name, settings) => {
      const first = applyGuard(settings, fakeExpected, noneExist).text;

      const second = applyGuard(first, fakeExpected, noneExist).text;

      expect(second).toBe(first);
    },
  );

  it('should preserve the foreign rtk hook and the existing allow and deny rules', () => {
    const settings = buildSettingsWithRtk(fakeHome);

    const result = applyGuard(settings, fakeExpected, noneExist).text;

    const data = parseJson(SettingsSchema, result);
    const bashEntries = data.hooks.PreToolUse.filter(
      (entry: { matcher: string }) => entry.matcher === '^Bash$',
    );
    const commands = bashEntries.flatMap((entry: HookEntry) => entry.hooks.map((h) => h.command));

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

    const hexlogEntries = hexlogEntriesOf(parseJson(SettingsSchema, result));

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

  it.each([
    {
      name: 'deny is an object',
      settings: '{ "permissions": { "deny": {} } }',
      pointer: '/permissions/deny',
      code: 'not-array',
      named: 'permissions.deny',
    },
    {
      name: 'PreToolUse is a string',
      settings: JSON.stringify({ permissions: { deny: [] }, hooks: { PreToolUse: 'x' } }),
      pointer: '/hooks/PreToolUse',
      code: 'not-array',
      named: 'hooks.PreToolUse',
    },
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
  ] as {
    name: string;
    settings: string;
    pointer: string;
    code?: string;
    named?: string;
  }[])(
    'should throw INVALID_INPUT naming the path when $name',
    ({ settings, pointer, code = 'not-object', named }) => {
      const error = captureError(() => applyGuard(settings, fakeExpected, noneExist));

      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details).toEqual([{ path: pointer, code, message: error.message }]);
      expect(error.message).toContain(named ?? (pointer === '' ? '<root>' : pointer.slice(1)));
    },
  );

  it('should repair a tampered matcher and type in place without duplicating the entry', () => {
    const tampered = tamperedSettings({ matcher: '^Edit$', type: 'prompt' });

    const repaired = applyGuard(tampered, fakeExpected, noneExist).text;

    const data = parseJson(SettingsSchema, repaired);

    expect(data.hooks.PreToolUse).toHaveLength(1);
    expect(at(data.hooks.PreToolUse, 0)).toMatchObject({
      matcher: '^Bash$',
      hooks: [{ type: 'command', command: fakeExpected.hookCommand, timeout: 10 }],
    });
    expect(verifyFake(repaired)).toEqual({ ok: true, missing: [] });
  });

  describe('with a hexlog hook that shares its entry with foreign hooks', () => {
    function preToolUseOf(text: string): unknown {
      return (parseJsonc(text) as { hooks: { PreToolUse: unknown } }).hooks.PreToolUse;
    }

    it.each(misplacedEntries)(
      'should move the hexlog hook to its own ^Bash$ entry and keep the foreign entry untouched with $name',
      ({ entry }) => {
        const settings = sharedSettings(entry);

        const repaired = applyGuard(settings, fakeExpected, noneExist).text;

        expect(preToolUseOf(repaired)).toEqual([
          { ...entry, hooks: [foreignHook] },
          { matcher: '^Bash$', hooks: [hexlogHook] },
        ]);
        expect(verifyFake(repaired)).toEqual({ ok: true, missing: [] });
      },
    );

    it.each(misplacedEntries)(
      'should preserve the comments when moving the hexlog hook with $name',
      ({ entry }) => {
        const settings = sharedSettings(entry);

        const repaired = applyGuard(settings, fakeExpected, noneExist).text;

        expect(repaired).toContain('// comment that must survive');
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

  it('should remove the three deny rules of an old <D> whose basename is hexlog', () => {
    const settings = settingsWithDeny(oldTrio);

    const result = applyGuard(settings, fakeExpected, noneExist).text;

    expect(denyOf(result)).toEqual(denyRulesOf(fakeExpected));
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
    const currentRules = denyRulesOf(fakeExpected);
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
    const hexlogEntries = hexlogEntriesOf(data);
    data.hooks.PreToolUse = data.hooks.PreToolUse.filter((entry) => !hexlogEntries.includes(entry));

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
    {
      change: 'the matcher of the hexlog entry was changed',
      settings: tamperedSettings({ matcher: '^Edit$', type: 'command' }),
    },
    {
      change: 'the hook type was changed',
      settings: tamperedSettings({ matcher: '^Bash$', type: 'prompt' }),
    },
    ...misplacedEntries.map(({ name, entry }) => ({
      change: `the hexlog hook shares an entry with foreign hooks under ${name}`,
      settings: sharedSettings(entry),
    })),
  ])('should report hook-matcher when $change', ({ settings }) => {
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
    // Prefixo com espaço: o `command` do settings precisa sobreviver ao ciclo
    // `shellQuote.quote` (instalador) → `shellQuote.parse` (verificação) mesmo com espaço
    // no caminho do HOME.
    let homeWithSpace: string;
    let D: string;
    let expected: ExpectedRules;
    let restoreHome: () => void;
    const version = '0.1.0';

    // Cópias do hook instaladas à parte, que se comportam de outro jeito (`hookFile` por versão).
    const VARIANT_CONTENT = {
      '0.1.0-error': 'this is not ( valid javascript {{{\n',
      '0.1.0-always-zero': 'process.exitCode = 0;\n',
      '0.1.0-always-two': "process.stderr.write('deny everything'); process.exitCode = 2;\n",
    };
    type Variant = keyof typeof VARIANT_CONTENT;
    let expectedVariants: Record<Variant, ExpectedRules>;

    // a criação dos diretórios fica no hook, não na coleta: a coleta roda até com `-t` e vazaria
    beforeAll(() => {
      homeWithSpace = createTempDir('home ');
      D = path.join(homeWithSpace, '.local', 'share', 'hexlog');
      expected = expectedRules(D, homeWithSpace, process.execPath, version);
      restoreHome = useHome(homeWithSpace);

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

      fs.mkdirSync(path.dirname(expected.hookFile), { recursive: true });
      fs.writeFileSync(
        expected.hookFile,
        fs.readFileSync(path.join(outdirBundle, 'bash-guard.mjs')),
      );

      expectedVariants = Object.fromEntries(
        Object.entries(VARIANT_CONTENT).map(([variantVersion, content]) => {
          const variantExpected = expectedRules(D, homeWithSpace, process.execPath, variantVersion);
          fs.mkdirSync(path.dirname(variantExpected.hookFile), { recursive: true });
          fs.writeFileSync(variantExpected.hookFile, content);
          return [variantVersion, variantExpected];
        }),
      ) as Record<Variant, ExpectedRules>;
    }, 30_000);

    afterAll(() => {
      restoreHome();
    });

    /** `verifyGuard` com o hook real sobre settings e claude.json completos; `overrides` muda só o que o caso prova. */
    function verifyReal(overrides: Partial<Parameters<typeof verifyGuard>[0]> = {}) {
      return verifyGuard({
        settingsText: buildFullSettings(expected, expected.hookCommand),
        claudeJsonText: buildFullClaudeJson(expected),
        expected,
        exists: fs.existsSync,
        runHook: runRealHook,
        artifactModified: false,
        ...overrides,
      });
    }

    it('should report nothing missing when settings and claude.json are complete', () => {
      const verification = verifyReal();

      expect(verification).toEqual({ ok: true, missing: [] });
    }, 15_000);

    it.each([
      {
        name: 'copy with syntax error',
        variantVersion: '0.1.0-error',
        item: 'hook-not-denying',
      },
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
    ] satisfies { name: string; variantVersion: Variant; item: MissingItem }[])(
      'should report $item for a $name in the real functional check',
      ({ variantVersion, item }) => {
        const variantExpected = expectedVariants[variantVersion];

        const verification = verifyReal({
          settingsText: buildFullSettings(expected, variantExpected.hookCommand),
        });

        expect(verification.missing).toContain(item);
      },
      15_000,
    );

    it('should report hook-file when the registered file does not exist', () => {
      const notInstalledExpected = expectedRules(
        D,
        homeWithSpace,
        process.execPath,
        'version-not-installed',
      );

      const verification = verifyReal({
        settingsText: buildFullSettings(expected, notInstalledExpected.hookCommand),
        expected: notInstalledExpected,
      });

      expect(verification.missing).toContain('hook-file');
    }, 15_000);

    it('should report node when the registered executable does not exist', () => {
      const missingExec = path.join(homeWithSpace, 'bin-that-does-not-exist', 'node');

      const verification = verifyReal({
        settingsText: buildFullSettings(
          expected,
          shellQuoteQuote([missingExec, expected.hookFile]),
        ),
      });

      expect(verification.missing).toContain('node');
    }, 15_000);

    it.each([
      { name: 'a shell command', command: 'bash -c true' },
      {
        name: 'an unrelated script run by node',
        command: `${process.execPath} /tmp/unrelated.mjs`,
      },
    ])(
      'should report hook when the command does not resolve to exactly [exec, file] under .local/lib/hexlog, as in $name',
      ({ command }) => {
        const verification = verifyReal({ settingsText: buildFullSettings(expected, command) });

        expect(verification.missing).toContain('hook');
      },
      15_000,
    );

    it('should report artifact-modified when the installed bytes diverge from the manifest', () => {
      const verification = verifyReal({ artifactModified: true });

      expect(verification.missing).toContain('artifact-modified');
    }, 15_000);

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
    ])(
      'should report mcp when claude.json is $name',
      ({ claudeJsonText }) => {
        const verification = verifyReal({ claudeJsonText });

        expect(verification.missing).toContain('mcp');
      },
      15_000,
    );
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

  it('should keep the Read rules off .local/lib/hexlog so the installed artifact stays readable', () => {
    const expected = expectedRules(fakeDataDir, fakeHome, '/usr/bin/node', '0.1.0');

    expect(expected.denyReadDir).not.toContain('.local/lib/hexlog');
    expect(expected.denyRead).not.toContain('.local/lib/hexlog');
  });
});

describe('registerGuard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Pasta temporária com um `settings.json` que tem as regras de deny de `deny` (por padrão, o trio de um <D> antigo). */
  function plantSettings(
    prefix: string,
    deny: string[] = oldTrio,
  ): { dir: string; settingsPath: string; before: string } {
    const dir = createTempDir(prefix);
    const settingsPath = path.join(dir, 'settings.json');
    const before = settingsWithDeny(deny);
    fs.writeFileSync(settingsPath, before);
    return { dir, settingsPath, before };
  }

  it('should keep the trio of an old <D> that exists on disk', () => {
    const existingOldD = path.join(createTempDir('register-old-exists'), 'hexlog');
    fs.mkdirSync(existingOldD);
    const settingsPath = path.join(path.dirname(existingOldD), 'settings.json');
    fs.writeFileSync(settingsPath, settingsWithDeny(trioOf(existingOldD)));

    const result = registerGuard({ settingsPath, expected: fakeExpected });

    expect(result).toMatchObject({ removed: [] });
    expect(denyOf(fs.readFileSync(settingsPath, 'utf8'))).toEqual(
      expect.arrayContaining(trioOf(existingOldD)),
    );
  });

  it('should refuse a missing settings.json with an INTERNAL error and no details', () => {
    const settingsPath = path.join(createTempDir('register-missing'), 'settings.json');

    expect(
      captureError(() => registerGuard({ settingsPath, expected: fakeExpected })),
    ).toMatchObject({
      code: 'INTERNAL',
      message: 'install the harness before installing hexlog',
      details: [],
    });
  });

  it('should refuse to write an invalid settings.json and leave the original untouched', () => {
    const dir = createTempDir('register-invalid');
    const settingsPath = path.join(dir, 'settings.json');
    const broken = '{"permissions":{"deny":["x"]}';
    fs.writeFileSync(settingsPath, broken);

    expect(() => registerGuard({ settingsPath, expected: fakeExpected })).toThrow(
      'refusing to write invalid settings.json',
    );
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(broken);
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it('should write .bak-hexlog and settings.json through writeFileAtomic', () => {
    const { dir, settingsPath, before } = plantSettings('register-atomic');
    const fsyncSpy = jest.spyOn(fs, 'fsyncSync');

    registerGuard({ settingsPath, expected: fakeExpected });

    // `writeFileAtomic` dá fsync no temporário antes do rename: uma vez por arquivo gravado.
    expect(fsyncSpy).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(`${settingsPath}.bak-hexlog`, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir).sort()).toEqual(['settings.json', 'settings.json.bak-hexlog']);
  });

  it('should write the text of applyGuard to settings.json and report the removed rules', () => {
    const { settingsPath, before } = plantSettings('register-final-text');

    const result = registerGuard({ settingsPath, expected: fakeExpected });

    expect(result).toEqual({ changed: true, removed: oldTrio });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(
      applyGuard(before, fakeExpected, noneExist).text,
    );
  });

  it('should not overwrite an existing .bak-hexlog', () => {
    const { settingsPath } = plantSettings('register-bak-preserved');
    fs.writeFileSync(`${settingsPath}.bak-hexlog`, 'backup original');

    const result = registerGuard({ settingsPath, expected: fakeExpected });

    expect(result).toMatchObject({ changed: true });
    expect(fs.readFileSync(`${settingsPath}.bak-hexlog`, 'utf8')).toBe('backup original');
    expect(denyOf(fs.readFileSync(settingsPath, 'utf8'))).not.toContain(`Read(/${oldDataDir})`);
  });

  it.each(['EPERM', 'ENOTSUP'])(
    'should turn %s from the backup hard link into a HexlogError before writing',
    (code) => {
      const { dir, settingsPath, before } = plantSettings('register-no-hardlink');
      jest.spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error(`${code}: /abs/secret/path`), { code });
      });

      const error = captureError(() => registerGuard({ settingsPath, expected: fakeExpected }));

      expect(error).toMatchObject({
        code: 'INTERNAL',
        message: expect.stringContaining('may not support hard links'),
      });
      expect(error.message).not.toContain('/abs/secret/path');
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
      expect(fs.readdirSync(dir)).toEqual(['settings.json']);
    },
  );

  it('should rethrow an EACCES from the backup hard link unchanged and keep settings.json', () => {
    const { dir, settingsPath, before } = plantSettings('register-hardlink-eacces');
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    jest.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw denied;
    });

    let thrown: unknown;
    try {
      registerGuard({ settingsPath, expected: fakeExpected });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(denied);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it('should write to the symlink target and keep the link and the mode', () => {
    const dir = createTempDir('register-symlink');
    const realFile = path.join(dir, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(realFile));
    const before = settingsWithDeny(oldTrio);
    fs.writeFileSync(realFile, before);
    fs.chmodSync(realFile, 0o644);
    const settingsPath = path.join(dir, 'settings.json');
    fs.symlinkSync(realFile, settingsPath);

    const result = registerGuard({ settingsPath, expected: fakeExpected });

    expect(result).toMatchObject({ changed: true });
    expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(realFile, 'utf8')).toBe(
      applyGuard(before, fakeExpected, noneExist).text,
    );
    expect(fs.statSync(realFile).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(`${settingsPath}.bak-hexlog`, 'utf8')).toBe(before);
  });

  // Como root, `accessSync(W_OK)` passa mesmo com `chmod 0555`, então o teste não tem o que provar.
  const itNotRoot = process.getuid?.() === 0 ? it.skip : it;

  itNotRoot('should fail before the backup when the symlink target is not writable', () => {
    const dir = createTempDir('register-symlink-readonly');
    const dotfiles = path.join(dir, 'dotfiles');
    const realFile = path.join(dotfiles, 'settings.json');
    fs.mkdirSync(dotfiles);
    const before = settingsWithDeny(oldTrio);
    fs.writeFileSync(realFile, before);
    const settingsPath = path.join(dir, 'settings.json');
    fs.symlinkSync(realFile, settingsPath);
    fs.chmodSync(dotfiles, 0o555);

    try {
      expect(() => registerGuard({ settingsPath, expected: fakeExpected })).toThrow(/not writable/);
      expect(fs.existsSync(`${settingsPath}.bak-hexlog`)).toBe(false);
      expect(fs.readFileSync(realFile, 'utf8')).toBe(before);
    } finally {
      fs.chmodSync(dotfiles, 0o755);
    }
  });

  it('should return an empty removed when there is no old <D>', () => {
    const { settingsPath } = plantSettings('register-removed-empty', trioOf(fakeDataDir));

    const result = registerGuard({ settingsPath, expected: fakeExpected });

    expect(result).toEqual({ changed: true, removed: [] });
  });

  it('should apply the 4 deny rules and the hook pointing to the installed versionDir', () => {
    const home = createTempDir('register-template');
    const D = path.join(home, '.local', 'share', 'hexlog');
    const expected = expectedRules(D, home, process.execPath, '0.1.0');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, buildSettingsTemplate(home));

    const { changed } = registerGuard({ settingsPath, expected });

    const finalText = fs.readFileSync(settingsPath, 'utf8');
    const data = parseJson(SettingsSchema, finalText);

    expect(changed).toBe(true);
    expect(data.permissions.deny).toEqual(expect.arrayContaining(denyRulesOf(expected)));
    expect(finalText).toContain(expected.hookCommand);
    expect(finalText).not.toContain(repoRoot);
    expect(fs.existsSync(`${settingsPath}.bak-hexlog`)).toBe(true);
  });
});
