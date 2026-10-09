import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
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
// puros de I5/I6, onde só interessa a lógica de `verifyGuard`.
function simulatedRunHook(_exec: string, _file: string, stdin: string): { status: number | null } {
  const { tool_input } = JSON.parse(stdin) as { tool_input: { command: string } };
  return { status: tool_input.command.includes('/probe') ? 2 : 0 };
}

describe('I5: applyGuard idempotente e não intrusivo', () => {
  const home = '/home/test-user';
  const D = path.join(home, '.local', 'share', 'hexlog');
  const expected = expectedRules(D, home, '/usr/bin/node', '0.1.0');

  test('applyGuard duas vezes produz o mesmo texto', () => {
    const first = applyGuard(buildSettingsTemplate(home), expected, noneExist).text;
    const second = applyGuard(first, expected, noneExist).text;
    expect(second).toBe(first);
  });

  test('sobre o settings regenerado do template, restaura as 4 regras e o hook', () => {
    const result = applyGuard(buildSettingsTemplate(home), expected, noneExist).text;
    const verification = verifyGuard({
      settingsText: result,
      claudeJsonText: buildFullClaudeJson(expected),
      expected,
      exists: alwaysExists,
      runHook: simulatedRunHook,
      artifactModified: false,
    });
    expect(verification).toEqual({ ok: true, missing: [] });
  });

  test('preserva entradas alheias (rtk hook claude e as regras/allow existentes)', () => {
    const result = applyGuard(buildSettingsWithRtk(home), expected, noneExist).text;
    const data = parseJson(SettingsSchema, result);
    expect(data.permissions.allow).toEqual(['mcp__hindsight__*']);
    expect(data.permissions.deny).toEqual(
      expect.arrayContaining(['mcp__gitnexus__cypher', 'mcp__gitnexus__rename']),
    );
    const bashEntries = data.hooks.PreToolUse.filter(
      (entry: { matcher: string }) => entry.matcher === '^Bash$',
    );
    const commands = bashEntries.flatMap((entry: { hooks: { command: string }[] }) =>
      entry.hooks.map((h) => h.command),
    );
    expect(commands).toContain('rtk hook claude');
    expect(commands).toContain(`${home}/.claude/bin/harness hook worktree-guard`);
    expect(commands).toContain(`${home}/.claude/bin/harness hook commit-message-guard`);
  });

  test('substitui a entrada com command de versão antiga sem duplicar', () => {
    const oldExpected = expectedRules(D, home, '/usr/bin/node', '0.0.9');
    const withOldVersion = applyGuard(buildSettingsTemplate(home), oldExpected, noneExist).text;
    const result = applyGuard(withOldVersion, expected, noneExist).text;
    const data = parseJson(SettingsSchema, result);
    const hexlogEntries = data.hooks.PreToolUse.filter((entry: { hooks: { command: string }[] }) =>
      entry.hooks.some(
        (h) => typeof h.command === 'string' && h.command.includes('bash-guard.mjs'),
      ),
    );
    expect(hexlogEntries).toHaveLength(1);
    expect(at(at(hexlogEntries, 0).hooks, 0).command).toBe(expected.hookCommand);
  });

  test('JSON resultante é válido e preserva comentários existentes', () => {
    const result = applyGuard(buildSettingsWithRtk(home), expected, noneExist).text;
    const errors: ParseError[] = [];
    parseJsonc(result, errors);
    expect(errors).toHaveLength(0);
    expect(result).toContain('// example comment');
  });

  test('settings sem comentários continua JSON.parse válido depois de applyGuard', () => {
    const result = applyGuard(buildSettingsTemplate(home), expected, noneExist).text;
    expect(() => {
      JSON.parse(result);
    }).not.toThrow();
  });

  test('verifyGuard lista cada regra de deny quando removida individualmente', () => {
    const full = applyGuard(buildSettingsTemplate(home), expected, noneExist).text;
    const claudeJson = buildFullClaudeJson(expected);
    const cases: [string, MissingItem][] = [
      [expected.denyReadDir, 'deny-read-dir'],
      [expected.denyRead, 'deny-read'],
      [expected.denyEdit, 'deny-edit'],
      [expected.denyEditLib, 'deny-edit-lib'],
    ];
    for (const [rule, item] of cases) {
      const data = parseJson(SettingsSchema, full);
      data.permissions.deny = data.permissions.deny.filter((r: string) => r !== rule);
      const verification = verifyGuard({
        settingsText: JSON.stringify(data),
        claudeJsonText: claudeJson,
        expected,
        exists: alwaysExists,
        runHook: simulatedRunHook,
        artifactModified: false,
      });
      expect(verification.missing).toContain(item);
    }
  });

  test('verifyGuard aponta "hook" quando a entrada do hook é removida', () => {
    const full = applyGuard(buildSettingsTemplate(home), expected, noneExist).text;
    const data = parseJson(SettingsSchema, full);
    data.hooks.PreToolUse = data.hooks.PreToolUse.filter(
      (entry: { hooks: { command: string }[] }) =>
        !entry.hooks.some(
          (h) => typeof h.command === 'string' && h.command.includes('bash-guard.mjs'),
        ),
    );
    const verification = verifyGuard({
      settingsText: JSON.stringify(data),
      claudeJsonText: buildFullClaudeJson(expected),
      expected,
      exists: alwaysExists,
      runHook: simulatedRunHook,
      artifactModified: false,
    });
    expect(verification.missing).toContain('hook');
  });
});

describe('M19/M1: settings with the wrong shape or a tampered hook entry', () => {
  const home = '/home/test-user';
  const D = path.join(home, '.local', 'share', 'hexlog');
  const expected = expectedRules(D, home, '/usr/bin/node', '0.1.0');
  const claudeJson = buildFullClaudeJson(expected);

  function verify(settingsText: string) {
    return verifyGuard({
      settingsText,
      claudeJsonText: claudeJson,
      expected,
      exists: alwaysExists,
      runHook: simulatedRunHook,
      artifactModified: false,
    });
  }

  function tamperedSettings(entry: { matcher: string; type: string }): string {
    return JSON.stringify({
      permissions: {
        allow: [],
        deny: [expected.denyReadDir, expected.denyRead, expected.denyEdit, expected.denyEditLib],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: entry.matcher,
            hooks: [{ type: entry.type, command: expected.hookCommand, timeout: 10 }],
          },
        ],
      },
    });
  }

  test('applyGuard throws HexlogError INVALID_INPUT naming /permissions/deny when deny is an object', () => {
    const error = captureError(() =>
      applyGuard('{ "permissions": { "deny": {} } }', expected, noneExist),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('permissions.deny');
    expect(error.details).toEqual([
      { path: '/permissions/deny', code: 'not-array', message: error.message },
    ]);
  });

  test('applyGuard throws HexlogError INVALID_INPUT naming /hooks/PreToolUse when PreToolUse is a string', () => {
    const settings = JSON.stringify({ permissions: { deny: [] }, hooks: { PreToolUse: 'x' } });
    const error = captureError(() => applyGuard(settings, expected, noneExist));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('hooks.PreToolUse');
    expect(error.details[0]?.path).toBe('/hooks/PreToolUse');
  });

  test('verifyGuard reports every deny rule as missing instead of throwing when deny is not an array', () => {
    const verification = verify(JSON.stringify({ permissions: { deny: 'x' } }));
    expect(verification.missing).toEqual(
      expect.arrayContaining(['deny-read-dir', 'deny-read', 'deny-edit', 'deny-edit-lib', 'hook']),
    );
  });

  test('verifyGuard reports hook-matcher when the hexlog entry matcher was changed', () => {
    const verification = verify(tamperedSettings({ matcher: '^Edit$', type: HOOK_TYPE }));
    expect(verification.missing).toEqual(['hook-matcher']);
  });

  test('verifyGuard reports hook-matcher when the hook type was changed', () => {
    const verification = verify(tamperedSettings({ matcher: '^Bash$', type: 'prompt' }));
    expect(verification.missing).toEqual(['hook-matcher']);
  });

  test('applyGuard repairs a tampered matcher and type in place without duplicating the entry', () => {
    const tampered = tamperedSettings({ matcher: '^Edit$', type: 'prompt' });
    const repaired = applyGuard(tampered, expected, noneExist).text;
    const data = parseJson(SettingsSchema, repaired);
    expect(data.hooks.PreToolUse).toHaveLength(1);
    expect(at(data.hooks.PreToolUse, 0)).toMatchObject({
      matcher: '^Bash$',
      hooks: [{ type: HOOK_TYPE, command: expected.hookCommand, timeout: 10 }],
    });
    expect(verify(repaired)).toEqual({ ok: true, missing: [] });
  });

  test('applyGuard is idempotent after repairing the matcher', () => {
    const tampered = tamperedSettings({ matcher: '^Edit$', type: 'prompt' });
    const first = applyGuard(tampered, expected, noneExist).text;
    expect(applyGuard(first, expected, noneExist).text).toBe(first);
  });

  describe('hexlog hook sharing its entry with foreign hooks', () => {
    const foreignHook = { type: HOOK_TYPE, command: 'foreign-hook --flag', timeout: 5 };
    const hexlogHook = { type: HOOK_TYPE, command: expected.hookCommand, timeout: 10 };

    function sharedSettings(entry: object): string {
      return `{
  // comment that must survive
  "permissions": { "deny": ${JSON.stringify([
    expected.denyReadDir,
    expected.denyRead,
    expected.denyEdit,
    expected.denyEditLib,
  ])} },
  "hooks": { "PreToolUse": [${JSON.stringify(entry)}] }
}`;
    }

    function preToolUseOf(text: string): unknown {
      return (parseJsonc(text) as { hooks: { PreToolUse: unknown } }).hooks.PreToolUse;
    }

    test.each([
      ['a wider matcher', { matcher: 'Bash|Edit|Write', hooks: [foreignHook, hexlogHook] }],
      ['no matcher', { hooks: [hexlogHook, foreignHook] }],
    ])(
      'moves the hexlog hook to its own ^Bash$ entry and keeps the foreign entry untouched (%s)',
      (_label, entry) => {
        const settings = sharedSettings(entry);
        expect(verify(settings).missing).toEqual(['hook-matcher']);

        const repaired = applyGuard(settings, expected, noneExist).text;

        expect(preToolUseOf(repaired)).toEqual([
          { ...entry, hooks: [foreignHook] },
          { matcher: '^Bash$', hooks: [hexlogHook] },
        ]);
        expect(repaired).toContain('// comment that must survive');
        expect(verify(repaired)).toEqual({ ok: true, missing: [] });
        expect(applyGuard(repaired, expected, noneExist).text).toBe(repaired);
      },
    );

    test('leaves a shared entry alone when its matcher is already ^Bash$', () => {
      const settings = sharedSettings({ matcher: '^Bash$', hooks: [foreignHook, hexlogHook] });
      expect(applyGuard(settings, expected, noneExist).text).toBe(settings);
    });

    test('fixes the matcher in place when the hexlog hook is the only one in the entry', () => {
      const settings = sharedSettings({ matcher: 'Bash|Edit', hooks: [hexlogHook] });
      const repaired = applyGuard(settings, expected, noneExist).text;
      expect(preToolUseOf(repaired)).toEqual([{ matcher: '^Bash$', hooks: [hexlogHook] }]);
    });
  });

  describe('settings.json whose ancestors are not objects', () => {
    test.each([
      ['permissions is a string', '{"permissions":"x"}', '/permissions'],
      ['permissions is an array', '{"permissions":[]}', '/permissions'],
      ['permissions is null', '{"permissions":null}', '/permissions'],
      ['hooks is a string', '{"permissions":{"deny":[]},"hooks":"x"}', '/hooks'],
      ['the root is an array', '[]', ''],
      ['the root is null', 'null', ''],
    ])('applyGuard throws INVALID_INPUT naming the path when %s', (_label, settings, pointer) => {
      const error = captureError(() => applyGuard(settings, expected, noneExist));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details).toEqual([
        { path: pointer, code: 'not-object', message: error.message },
      ]);
      expect(error.message).toContain(pointer === '' ? '<root>' : pointer.slice(1));
    });
  });
});

describe('I6: as 4 regras de deny exatas (QN4)', () => {
  const home = '/home/test-user';
  const D = path.join(home, '.local', 'share', 'hexlog');
  const expected = expectedRules(D, home, '/usr/bin/node', '0.1.0');

  test('as 4 regras têm o texto exato esperado pelo plano', () => {
    expect(expected.denyReadDir).toBe(`Read(/${D})`);
    expect(expected.denyRead).toBe(`Read(/${D}/**)`);
    expect(expected.denyEdit).toBe(`Edit(/${D}/**)`);
    expect(expected.denyEditLib).toBe(`Edit(/${home}/.local/lib/hexlog/**)`);
  });

  test('nenhuma regra usa barra única (o prefixo é sempre "//")', () => {
    for (const rule of [
      expected.denyReadDir,
      expected.denyRead,
      expected.denyEdit,
      expected.denyEditLib,
    ]) {
      expect(rule).toMatch(/^(Read|Edit)\(\/\//);
    }
  });

  test('nenhuma regra Read cobre .local/lib/hexlog (leitura do artefato instalado continua liberada)', () => {
    expect(expected.denyReadDir).not.toContain('.local/lib/hexlog');
    expect(expected.denyRead).not.toContain('.local/lib/hexlog');
  });

  test('sem a quarta regra, verifyGuard aponta deny-edit-lib', () => {
    const full = applyGuard(buildSettingsTemplate(home), expected, noneExist).text;
    const data = parseJson(SettingsSchema, full);
    data.permissions.deny = data.permissions.deny.filter((r: string) => r !== expected.denyEditLib);
    const verification = verifyGuard({
      settingsText: JSON.stringify(data),
      claudeJsonText: buildFullClaudeJson(expected),
      expected,
      exists: alwaysExists,
      runHook: simulatedRunHook,
      artifactModified: false,
    });
    expect(verification.missing).toEqual(['deny-edit-lib']);
  });
});

describe('TI6: deny de <D> antigo removido só pelo predicado fechado', () => {
  const home = '/home/test-user';
  const D = path.join(home, '.local', 'share', 'hexlog');
  const expected = expectedRules(D, home, '/usr/bin/node', '0.1.0');
  const trioOf = (oldD: string) => {
    const old = expectedRules(oldD, home, '/usr/bin/node', '0.1.0');
    return [old.denyReadDir, old.denyRead, old.denyEdit];
  };
  const settingsWithDeny = (deny: string[]) =>
    JSON.stringify({ permissions: { deny } }, null, 2) + '\n';
  const DenySchema = z.object({ permissions: z.object({ deny: z.array(z.string()) }) });
  const denyOf = (text: string) => parseJson(DenySchema, text).permissions.deny;
  const oldD = '/mnt/old/data/hexlog';

  test('deny: remove as três regras de um <D> antigo com basename hexlog', () => {
    const result = applyGuard(settingsWithDeny(trioOf(oldD)), expected, noneExist).text;
    expect(denyOf(result)).toEqual([
      expected.denyReadDir,
      expected.denyRead,
      expected.denyEdit,
      expected.denyEditLib,
    ]);
  });

  test('deny: mantém as regras do <D> atual quando há um <D> antigo ao lado', () => {
    const current = trioOf(D);
    const result = applyGuard(
      settingsWithDeny([...trioOf(oldD), ...current]),
      expected,
      noneExist,
    ).text;
    expect(denyOf(result)).toEqual([...current, expected.denyEditLib]);
  });

  test('deny: regra avulsa do usuário sobrevive, mesmo parecida com a do <D> antigo', () => {
    const stray = ['Read(//mnt/old/data/hexlog/secret)', 'Bash(rm:*)', 'Edit(//mnt/old/**)'];
    const result = applyGuard(
      settingsWithDeny([...stray, ...trioOf(oldD)]),
      expected,
      noneExist,
    ).text;
    expect(denyOf(result)).toEqual(expect.arrayContaining(stray));
    expect(denyOf(result)).not.toContain(`Read(/${oldD})`);
  });

  test('deny: <D> antigo com basename diferente de hexlog não é removido', () => {
    const foreign = trioOf('/mnt/old/data/other');
    const result = applyGuard(settingsWithDeny(foreign), expected, noneExist).text;
    expect(denyOf(result)).toEqual(expect.arrayContaining(foreign));
  });

  test('deny: trio incompleto (uma ou duas regras) não é removido', () => {
    const [readDir, read] = trioOf(oldD);
    for (const partial of [[readDir], [readDir, read]] as string[][]) {
      const result = applyGuard(settingsWithDeny(partial), expected, noneExist).text;
      expect(denyOf(result)).toEqual(expect.arrayContaining(partial));
    }
  });

  describe('deny em linha única (jsonc-parser não remove o último elemento com o colchete na mesma linha)', () => {
    const currentRules = [
      expected.denyReadDir,
      expected.denyRead,
      expected.denyEdit,
      expected.denyEditLib,
    ];
    const inline = (deny: string[]) => `{"permissions":{"deny":${JSON.stringify(deny)}}}`;

    test('trio antigo no fim do array', () => {
      const result = applyGuard(inline(['Bash(rm:*)', ...trioOf(oldD)]), expected, noneExist).text;
      expect(denyOf(result)).toEqual(['Bash(rm:*)', ...currentRules]);
    });

    test('só o trio antigo no array', () => {
      const result = applyGuard(inline(trioOf(oldD)), expected, noneExist).text;
      expect(denyOf(result)).toEqual(currentRules);
    });

    test('trio antigo espalhado entre regras avulsas', () => {
      const [readDir, read, edit] = trioOf(oldD);
      const result = applyGuard(
        inline([readDir!, 'Bash(rm:*)', read!, 'Bash(ls:*)', edit!]),
        expected,
        noneExist,
      ).text;
      expect(denyOf(result)).toEqual(['Bash(rm:*)', 'Bash(ls:*)', ...currentRules]);
    });
  });

  test('deny: <D> antigo que ainda existe no disco mantém o trio; ausente, remove', () => {
    const text = settingsWithDeny(trioOf(oldD));
    const kept = applyGuard(text, expected, (candidate) => candidate === oldD).text;
    expect(denyOf(kept)).toEqual(expect.arrayContaining(trioOf(oldD)));
    const removed = applyGuard(text, expected, noneExist).text;
    expect(denyOf(removed)).not.toContain(`Read(/${oldD})`);
  });

  test('deny: registerGuard mantém o trio de um <D> antigo que existe em disco', () => {
    const tmpHome = createTempDir('deny-old-exists');
    try {
      const existingOldD = path.join(tmpHome, 'hexlog');
      fs.mkdirSync(existingOldD);
      const settingsPath = path.join(tmpHome, 'settings.json');
      fs.writeFileSync(settingsPath, settingsWithDeny(trioOf(existingOldD)));

      expect(registerGuard({ settingsPath, expected })).toMatchObject({ removed: [] });
      expect(denyOf(fs.readFileSync(settingsPath, 'utf8'))).toEqual(
        expect.arrayContaining(trioOf(existingOldD)),
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('deny: registerGuard recusa gravar settings.json inválido e não toca o original', () => {
    const tmpHome = createTempDir('deny-invalid');
    try {
      const settingsPath = path.join(tmpHome, 'settings.json');
      const broken = '{"permissions":{"deny":["x"]}';
      fs.writeFileSync(settingsPath, broken);

      expect(() => registerGuard({ settingsPath, expected })).toThrow(
        'refusing to write invalid settings.json',
      );
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(broken);
      expect(fs.readdirSync(tmpHome)).toEqual(['settings.json']);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('deny: aplicar duas vezes produz o mesmo texto (I5)', () => {
    const first = applyGuard(settingsWithDeny(trioOf(oldD)), expected, noneExist).text;
    expect(applyGuard(first, expected, noneExist).text).toBe(first);
  });

  test('deny: registerGuard grava .bak-hexlog e settings.json por writeFileAtomic', () => {
    const tmpHome = createTempDir('deny-atomic');
    const fsyncSpy = jest.spyOn(fsDefault, 'fsyncSync');
    try {
      const settingsPath = path.join(tmpHome, 'settings.json');
      const before = settingsWithDeny(trioOf(oldD));
      fs.writeFileSync(settingsPath, before);

      expect(registerGuard({ settingsPath, expected })).toEqual({
        changed: true,
        removed: trioOf(oldD),
      });

      // `writeFileAtomic` dá fsync no temporário antes do rename: uma vez por arquivo gravado.
      expect(fsyncSpy).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(`${settingsPath}.bak-hexlog`, 'utf8')).toBe(before);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(
        applyGuard(before, expected, noneExist).text,
      );
      expect(denyOf(fs.readFileSync(settingsPath, 'utf8'))).not.toContain(`Read(/${oldD})`);
      expect(fs.readdirSync(tmpHome).sort()).toEqual(['settings.json', 'settings.json.bak-hexlog']);
    } finally {
      fsyncSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('deny: registerGuard não sobrescreve um .bak-hexlog existente', () => {
    const tmpHome = createTempDir('deny-bak-preserved');
    try {
      const settingsPath = path.join(tmpHome, 'settings.json');
      fs.writeFileSync(`${settingsPath}.bak-hexlog`, 'backup original');
      fs.writeFileSync(settingsPath, settingsWithDeny(trioOf(oldD)));

      expect(registerGuard({ settingsPath, expected })).toMatchObject({ changed: true });

      expect(fs.readFileSync(`${settingsPath}.bak-hexlog`, 'utf8')).toBe('backup original');
      expect(denyOf(fs.readFileSync(settingsPath, 'utf8'))).not.toContain(`Read(/${oldD})`);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('deny: registerGuard grava no destino do symlink e mantém o link e o modo', () => {
    const tmpHome = createTempDir('deny-symlink');
    try {
      const realFile = path.join(tmpHome, 'dotfiles', 'settings.json');
      fs.mkdirSync(path.dirname(realFile));
      const before = settingsWithDeny(trioOf(oldD));
      fs.writeFileSync(realFile, before);
      fs.chmodSync(realFile, 0o644);
      const settingsPath = path.join(tmpHome, 'settings.json');
      fs.symlinkSync(realFile, settingsPath);

      expect(registerGuard({ settingsPath, expected })).toMatchObject({ changed: true });

      expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(realFile, 'utf8')).toBe(applyGuard(before, expected, noneExist).text);
      expect(fs.statSync(realFile).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(`${settingsPath}.bak-hexlog`, 'utf8')).toBe(before);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // Como root, `accessSync(W_OK)` passa mesmo com `chmod 0555`, então o teste não tem o que provar.
  const itNotRoot = process.getuid?.() === 0 ? test.skip : test;

  itNotRoot(
    'deny: registerGuard falha antes do backup quando o destino do symlink não é gravável',
    () => {
      const tmpHome = createTempDir('deny-symlink-readonly');
      const dotfiles = path.join(tmpHome, 'dotfiles');
      try {
        const realFile = path.join(dotfiles, 'settings.json');
        fs.mkdirSync(dotfiles);
        const before = settingsWithDeny(trioOf(oldD));
        fs.writeFileSync(realFile, before);
        const settingsPath = path.join(tmpHome, 'settings.json');
        fs.symlinkSync(realFile, settingsPath);
        fs.chmodSync(dotfiles, 0o555);

        expect(() => registerGuard({ settingsPath, expected })).toThrow(/not writable/);

        expect(fs.existsSync(`${settingsPath}.bak-hexlog`)).toBe(false);
        expect(fs.readFileSync(realFile, 'utf8')).toBe(before);
      } finally {
        fs.chmodSync(dotfiles, 0o755);
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    },
  );

  test('deny: registerGuard devolve removed vazio quando não há <D> antigo', () => {
    const tmpHome = createTempDir('deny-removed-empty');
    try {
      const settingsPath = path.join(tmpHome, 'settings.json');
      fs.writeFileSync(settingsPath, settingsWithDeny(trioOf(D)));

      expect(registerGuard({ settingsPath, expected })).toEqual({ changed: true, removed: [] });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('I7: verificação com execução real do hook instalado', () => {
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

  test('hook real instalado: faltando vazio quando settings e claude.json estão completos', () => {
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
  for (const scenario of functionalCases) {
    test(`checagem funcional real: ${scenario.name} → ${scenario.item}`, () => {
      const variantExpected = expectedVariants.get(scenario.variantVersion)!;
      const settings = buildFullSettings(expected, variantExpected.hookCommand);
      const verification = verifyGuard({
        settingsText: settings,
        claudeJsonText: buildFullClaudeJson(expected),
        expected,
        exists: fs.existsSync,
        runHook: runRealHook,
        artifactModified: false,
      });
      expect(verification.missing).toContain(scenario.item);
    });
  }

  test('hook-file quando o arquivo registrado não existe', () => {
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

  test('node quando o executável registrado não existe', () => {
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

  test('command que não vira exatamente [exec, file] sob .local/lib/hexlog → hook', () => {
    for (const command of ['bash -c true', `${process.execPath} /tmp/unrelated.mjs`]) {
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
    }
  });

  test('artifact-modified quando os bytes instalados divergem do manifesto', () => {
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

  test('mcp quando o claude.json é nulo ou não aponta para o servidor instalado', () => {
    const settings = buildFullSettings(expected, expected.hookCommand);
    const wrongClaudeJson = JSON.stringify({
      mcpServers: {
        hexlog: { command: expected.execPath, args: ['/wrong/path/server.mjs'] },
      },
    });
    for (const claudeJsonText of [null, wrongClaudeJson]) {
      const verification = verifyGuard({
        settingsText: settings,
        claudeJsonText,
        expected,
        exists: fs.existsSync,
        runHook: runRealHook,
        artifactModified: false,
      });
      expect(verification.missing).toContain('mcp');
    }
  });
});

// Bundles reais construídos uma vez (esbuild custa ~1s) e reaproveitados por
// todos os casos de B2/B3 que não precisam de um build "diferente" de propósito.
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
    throw new Error(`build for B2/B3 failed: ${build.stderr}`);
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

/** Sobe o servidor preparado num HOME/XDG_DATA_HOME descartáveis e conta as tools anunciadas (uso real, B2(a)). */
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

describe('B2: instalação versionada do artefato (installArtifact)', () => {
  test('(a) instala em <HOME>/.local/lib/hexlog/<versão>/ com os 2 bundles e manifest.json (Client real)', async () => {
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
      expect(result.action).toBe('installed');
      const versionDir = versionDirOf(home, '0.1.0');
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

  test('(b) registerGuard aplica as 4 regras de deny e o hook apontando pro versionDir instalado', () => {
    const home = createTempDir('install-b');
    try {
      const D = path.join(home, '.local', 'share', 'hexlog');
      const expected = expectedRules(D, home, process.execPath, '0.1.0');
      const settingsPath = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, buildSettingsTemplate(home));

      const { changed } = registerGuard({ settingsPath, expected });
      expect(changed).toBe(true);

      const finalText = fs.readFileSync(settingsPath, 'utf8');
      const data = parseJson(SettingsSchema, finalText);
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

  test('(c) segunda execução sem mudança decide pelos bytes instalados: nada, settings e mtime intocados', async () => {
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

  test('(d) versão nova cria diretório novo, mantém o antigo e substitui a entrada do hook sem duplicar', async () => {
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
  }, 20_000);

  test('(e) mesma versão reinstalada com bundles diferentes troca atomicamente e avisa', async () => {
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

  test('(f) qualquer falha na verificação do preparo aborta sem tocar no que já estava instalado', async () => {
    const home = createTempDir('install-f');
    try {
      const baseArgs = {
        home,
        version: '0.1.0',
        commit: null,
        dirty: false,
        clock: () => new Date(),
      };

      // hook preparado que não nega (cópia que sempre "permite")
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

      // bundle com "Dynamic require of"
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

      // servidor preparado que não lista todas as tools
      await expect(
        installArtifact({
          ...baseArgs,
          bundles: realBundles,
          runHook: runRealHookForInstall,
          verifyServer: () => Promise.resolve(TOOLS_COUNT - 1),
        }),
      ).rejects.toThrow(`${TOOLS_COUNT - 1} tools`);
      expect(fs.existsSync(versionDirOf(home, '0.1.0'))).toBe(false);

      // instala com sucesso e confirma que uma falha subsequente não mexe no que já está instalado
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

  test('(g) artefato instalado alterado por fora é reparado na execução seguinte', async () => {
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

  test('(h) instaladores concorrentes: mesmo build convergem, builds diferentes só um vence', async () => {
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

  test('(h2) reinstalação concorrente: ENOENT no primeiro renameSync é tratado como concorrência, sem diretório misto', async () => {
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

  test('(h3) reinstalações concorrentes no mesmo ms não compartilham o diretório de backup', async () => {
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

describe('B2b: gravação da pasta de uma skill (writeSkillFolder)', () => {
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

  test('copia SKILL.md (e references/) para <home>/.claude/skills/<name>/', () => {
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

  test('instalar duas vezes seguidas deixa o arquivo idêntico', () => {
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

  test('sobrescreve um arquivo editado à mão com o canônico, sem criar .bak', () => {
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

  test('reinstalar a partir de uma srcDir sem um arquivo de references/ remove o órfão (U1)', () => {
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

  test('srcDir inexistente (cpSync falha): conteúdo anterior de dstDir continua intacto (N2)', () => {
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

  test('2º renameSync falha no meio da troca: dstDir continua com o conteúdo anterior (N1)', () => {
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

  test('varre os temporários legados skills/<nome>.tmp-<pid> e .old-<pid>, sem tocar em outras pastas', () => {
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

  test('falha no 2º renameSync não deixa temporário em skills/ nem em .claude/ e preserva a skill anterior', () => {
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

  test('nome com "/", "..", "." ou vazio é rejeitado antes de tocar no filesystem', () => {
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

describe('B3: install.ts --check (processo real)', () => {
  let home: string;
  let D: string;
  let version: string;

  beforeAll(() => {
    version = (
      JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    home = createTempDir('b3');
    // Fixa o <D> no HOME temporário: um XDG_DATA_HOME herdado com dado 0.x faria o instalador sair 2.
    D = path.join(home, '.local', 'share', 'hexlog');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), buildSettingsTemplate(home));

    const installation = runInstaller(home, D, []);
    if (installation.status !== 0) {
      throw new Error(
        `real baseline installation (B3) failed: ${installation.stderr}\n${installation.stdout}`,
      );
    }
  }, 30_000);

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runCheck(opts: { cwd?: string } = {}): { status: number | null; stdout: string } {
    const { status, stdout } = runInstaller(home, D, ['--check'], opts.cwd);
    return { status, stdout };
  }

  test('instalação completa: exit 0, sem artifact-modified nem artifact-outdated', () => {
    const { status, stdout } = runCheck();
    expect(status).toBe(0);
    expect(stdout).not.toContain('artifact-modified');
    expect(stdout).not.toContain('artifact-outdated');
  }, 15_000);

  test('diretório da versão removido: hook-file, exit 1', () => {
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

  test('diretório de uma skill removido: skill-file:<nome>, exit 1', () => {
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

  test('build atual diferente do manifesto com bytes instalados íntegros: aviso artifact-outdated, exit inalterado', () => {
    // Chamada direta (sem subprocesso): `runRealHook` herda `process.env` do
    // processo de teste, então o hook precisa enxergar o mesmo HOME temporário
    // usado pra montar `expected` — mesmo motivo do describe I7.
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

  test('mesmo resultado rodando o --check de outro cwd', () => {
    const fromRepo = runCheck();
    const fromOtherCwd = runCheck({ cwd: os.tmpdir() });
    expect(fromOtherCwd.status).toBe(fromRepo.status);
    expect(fromOtherCwd.stdout).toBe(fromRepo.stdout);
  }, 15_000);

  test('--check com <D> ilegível (ENOTDIR) ainda verifica, sem abortar cru', () => {
    const blocker = path.join(home, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const result = runInstaller(home, path.join(blocker, 'hexlog'), ['--check']);

    expect(result.stderr).not.toContain('ENOTDIR');
    expect(result.stdout).toContain('missing:');
  }, 15_000);

  test('argumento desconhecido sai 1 com a mensagem em stderr e nada escrito', () => {
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
});

describe('F6: install.ts sobre dado 0.x (processo real)', () => {
  const legacyFixture = path.join(repoRoot, 'test/fixtures/legacy-0x');
  const DenySchema = z.looseObject({ permissions: z.looseObject({ deny: z.array(z.string()) }) });
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

  test('lista: sem flag sobre dado 0.x sai 2, lista o que arquivaria e deixa <D> intacto', () => {
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

  test('archive-0x: lock 0.x vivo sai 1 sem instalar e sem apagar', () => {
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

  test('archive-0x: --check --archive-0x só verifica, nada é escrito (D7)', () => {
    const { home, D } = createInstallHome('f6-archive-check');
    fs.cpSync(legacyFixture, D, { recursive: true });
    const before = snapshotTree(home);

    const result = runInstaller(home, D, ['--check', '--archive-0x']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('missing:');
    expect(snapshotTree(home)).toEqual(before);
  }, 30_000);

  describe('instalação 1.0 ponta a ponta depois do arquivamento', () => {
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

    test('archive-0x: arquiva o dado 0.x em <D>/archive e depois instala a 1.0', () => {
      expect(first.status).toBe(0);
      expect(first.stdout).toMatch(/archived \d+ file\(s\) of 0\.x data into .*hexlog-0x-.*\.tar/);
      expect(first.stdout).toContain(`hexlog ${version}: `);
      expect(detectLegacy(D)).toEqual([]);
      expect(packagesOf(D)).toHaveLength(1);
      expect(fs.existsSync(path.join(versionDirOf(home, version), 'server.mjs'))).toBe(true);
    });

    test('deny: imprime uma linha removed deny rule por regra do <D> antigo e preserva a avulsa', () => {
      const printed = first.stdout
        .split('\n')
        .filter((line) => line.includes('removed deny rule:'));
      expect(printed).toEqual(oldDenyRules.map((rule) => `  removed deny rule: ${rule}`));

      const deny = parseJson(
        DenySchema,
        fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
      ).permissions.deny;
      expect(deny).toContain(strayRule);
      for (const rule of oldDenyRules) expect(deny).not.toContain(rule);
    });

    test('0.x: a segunda execução com --archive-0x não arquiva de novo e reinstala sem erro', () => {
      const packagesBefore = packagesOf(D);

      const second = runInstaller(home, D, ['--archive-0x']);

      expect(second.status).toBe(0);
      expect(second.stdout).not.toContain('archived');
      expect(second.stdout).not.toContain('removed deny rule');
      expect(packagesOf(D)).toEqual(packagesBefore);
    }, 60_000);
  });
});
