import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { quote as shellQuoteQuote } from 'shell-quote';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  expectedRules,
  applyGuard,
  verifyGuard,
  runRealHook,
  sha256,
  type ExpectedRules,
  type MissingItem,
} from '../src/guard.ts';
import {
  versionDirOf,
  readManifest,
  installArtifact,
  registerGuard,
  verifyInstallation,
  type Bundles,
} from '../src/installation.ts';
import { parseJson } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');

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
// entrada alheia `rtk hook claude` (~/.claude/settings.json:92-96).
function buildSettingsWithRtk(home: string): string {
  return `{
  // comentário de exemplo, precisa sobreviver às edições do jsonc-parser
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

// Equivalente mínimo de `own-harness/boot/settings.template.json:9-15`
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
      hexlog: { command: expected.serverExec, args: [expected.serverFile], env: {} },
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
  const home = '/home/usuario-teste';
  const D = path.join(home, '.local', 'share', 'hexlog');
  const expected = expectedRules(D, home, '/usr/bin/node', '0.1.0');

  test('applyGuard duas vezes produz o mesmo texto', () => {
    const first = applyGuard(buildSettingsTemplate(home), expected);
    const second = applyGuard(first, expected);
    expect(second).toBe(first);
  });

  test('sobre o settings regenerado do template, restaura as 4 regras e o hook', () => {
    const result = applyGuard(buildSettingsTemplate(home), expected);
    const verification = verifyGuard({
      settingsText: result,
      claudeJsonText: buildFullClaudeJson(expected),
      expected,
      exists: alwaysExists,
      runHook: simulatedRunHook,
    });
    expect(verification).toEqual({ ok: true, missing: [] });
  });

  test('preserva entradas alheias (rtk hook claude e as regras/allow existentes)', () => {
    const result = applyGuard(buildSettingsWithRtk(home), expected);
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
    const withOldVersion = applyGuard(buildSettingsTemplate(home), oldExpected);
    const result = applyGuard(withOldVersion, expected);
    const data = parseJson(SettingsSchema, result);
    const hexlogEntries = data.hooks.PreToolUse.filter((entry: { hooks: { command: string }[] }) =>
      entry.hooks.some(
        (h) => typeof h.command === 'string' && h.command.includes('bash-guard.mjs'),
      ),
    );
    expect(hexlogEntries).toHaveLength(1);
    expect(hexlogEntries[0].hooks[0].command).toBe(expected.hookCommand);
  });

  test('JSON resultante é válido e preserva comentários existentes', () => {
    const result = applyGuard(buildSettingsWithRtk(home), expected);
    const errors: ParseError[] = [];
    parseJsonc(result, errors);
    expect(errors).toHaveLength(0);
    expect(result).toContain('// comentário de exemplo');
  });

  test('settings sem comentários continua JSON.parse válido depois de applyGuard', () => {
    const result = applyGuard(buildSettingsTemplate(home), expected);
    expect(() => {
      JSON.parse(result);
    }).not.toThrow();
  });

  test('verifyGuard lista cada regra de deny quando removida individualmente', () => {
    const full = applyGuard(buildSettingsTemplate(home), expected);
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
      });
      expect(verification.missing).toContain(item);
    }
  });

  test('verifyGuard aponta "hook" quando a entrada do hook é removida', () => {
    const full = applyGuard(buildSettingsTemplate(home), expected);
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
    });
    expect(verification.missing).toContain('hook');
  });
});

describe('I6: as 4 regras de deny exatas (QN4)', () => {
  const home = '/home/usuario-teste';
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
    const full = applyGuard(buildSettingsTemplate(home), expected);
    const data = parseJson(SettingsSchema, full);
    data.permissions.deny = data.permissions.deny.filter((r: string) => r !== expected.denyEditLib);
    const verification = verifyGuard({
      settingsText: JSON.stringify(data),
      claudeJsonText: buildFullClaudeJson(expected),
      expected,
      exists: alwaysExists,
      runHook: simulatedRunHook,
    });
    expect(verification.missing).toEqual(['deny-edit-lib']);
  });
});

describe('I7: verificação com execução real do hook instalado', () => {
  // Prefixo com espaço (Critic iter3-7): o `command` do settings precisa
  // sobreviver ao ciclo `shellQuote.quote` (instalador) → `shellQuote.parse`
  // (verificação) mesmo com espaço no caminho do HOME.
  const homeWithSpace = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog casa-'));
  const D = path.join(homeWithSpace, '.local', 'share', 'hexlog');
  const version = '0.1.0';
  const expected = expectedRules(D, homeWithSpace, process.execPath, version);

  // `runRealHook` roda o hook num processo filho que herda `process.env`
  // (mesmo contrato de produção, onde o instalador roda como o usuário real):
  // pra `D` bater com o que o hook calcula, o `HOME` do processo de teste
  // precisa apontar pro `HOME` temporário enquanto este describe roda.
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_DATA_HOME;
  process.env.HOME = homeWithSpace;
  delete process.env.XDG_DATA_HOME;

  const outdirBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-guard-bundle-'));
  const build = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'test/fixtures/build-hook.ts'), outdirBundle],
    { encoding: 'utf8', cwd: repoRoot },
  );
  if (build.status !== 0) {
    throw new Error(`build do hook falhou: ${build.stderr}`);
  }
  const realBundle = fs.readFileSync(path.join(outdirBundle, 'bash-guard.mjs'));

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
  const expectedVariants = new Map<string, ExpectedRules>();
  for (const variant of variants) {
    const variantExpected = expectedRules(D, homeWithSpace, process.execPath, variant.version);
    fs.mkdirSync(path.dirname(variantExpected.hookFile), { recursive: true });
    fs.writeFileSync(variantExpected.hookFile, variant.content);
    expectedVariants.set(variant.version, variantExpected);
  }

  afterAll(() => {
    fs.rmSync(homeWithSpace, { recursive: true, force: true });
    fs.rmSync(outdirBundle, { recursive: true, force: true });
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
    });
    expect(verification).toEqual({ ok: true, missing: [] });
  });

  const functionalCases: { name: string; variantVersion: string; item: MissingItem }[] = [
    { name: 'cópia com erro de sintaxe', variantVersion: '0.1.0-error', item: 'hook-not-denying' },
    {
      name: 'script que sempre sai 0',
      variantVersion: '0.1.0-always-zero',
      item: 'hook-not-denying',
    },
    {
      name: 'script que sempre sai 2',
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
    });
    expect(verification.missing).toContain('hook-file');
  });

  test('node quando o executável registrado não existe', () => {
    const missingExec = path.join(homeWithSpace, 'bin-que-nao-existe', 'node');
    const commandWithFakeExec = shellQuoteQuote([missingExec, expected.hookFile]);
    const settings = buildFullSettings(expected, commandWithFakeExec);
    const verification = verifyGuard({
      settingsText: settings,
      claudeJsonText: buildFullClaudeJson(expected),
      expected,
      exists: fs.existsSync,
      runHook: runRealHook,
    });
    expect(verification.missing).toContain('node');
  });

  test('command que não vira exatamente [exec, file] sob .local/lib/hexlog → hook', () => {
    for (const command of ['bash -c true', `${process.execPath} /tmp/nada-a-ver.mjs`]) {
      const settings = buildFullSettings(expected, command);
      const verification = verifyGuard({
        settingsText: settings,
        claudeJsonText: buildFullClaudeJson(expected),
        expected,
        exists: fs.existsSync,
        runHook: runRealHook,
      });
      expect(verification.missing).toContain('hook');
    }
  });

  test('artifact-modified quando o hash do hook instalado diverge do manifesto', () => {
    const settings = buildFullSettings(expected, expected.hookCommand);
    const divergentManifest = {
      sha256: {
        server: sha256(Buffer.from('expected server')),
        hook: sha256(Buffer.from('different bytes')),
      },
    };
    const verification = verifyGuard({
      settingsText: settings,
      claudeJsonText: buildFullClaudeJson(expected),
      expected,
      exists: fs.existsSync,
      runHook: runRealHook,
      installedBytes: { server: null, hook: realBundle, manifest: divergentManifest },
    });
    expect(verification.missing).toContain('artifact-modified');
  });

  test('mcp quando o claude.json é nulo ou não aponta para o servidor instalado', () => {
    const settings = buildFullSettings(expected, expected.hookCommand);
    const wrongClaudeJson = JSON.stringify({
      mcpServers: {
        hexlog: { command: expected.serverExec, args: ['/wrong/path/server.mjs'] },
      },
    });
    for (const claudeJsonText of [null, wrongClaudeJson]) {
      const verification = verifyGuard({
        settingsText: settings,
        claudeJsonText,
        expected,
        exists: fs.existsSync,
        runHook: runRealHook,
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
  realBundlesOutdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-install-build-'));
  const build = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/build.ts'), '--outdir', realBundlesOutdir],
    {
      encoding: 'utf8',
      cwd: repoRoot,
    },
  );
  if (build.status !== 0) {
    throw new Error(`build para B2/B3 falhou: ${build.stderr}`);
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
  const disposableHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-verify-'));
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

const fakeVerifyServer = (): Promise<number> => Promise.resolve(10);

function runConcurrentFixture(
  home: string,
  version: string,
  variant: string,
  processId: number,
  totalProcesses: number,
): Promise<{ status: number | null; stdout: string }> {
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
      ],
      { cwd: repoRoot },
    );
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout }));
  });
}

describe('B2: instalação versionada do artefato (installArtifact)', () => {
  test('(a) instala em <HOME>/.local/lib/hexlog/<versão>/ com os 2 bundles e manifest.json (Client real)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-install-a-'));
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
        log: () => {},
      });
      expect(result.action).toBe('installed');
      const versionDir = versionDirOf(home, '0.1.0');
      expect(result.versionDir).toBe(versionDir);
      expect(fs.existsSync(path.join(versionDir, 'server.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(versionDir, 'bash-guard.mjs'))).toBe(true);
      expect(readManifest(versionDir)).toEqual({
        version: '0.1.0',
        sha256: { server: sha256(realBundles.server), hook: sha256(realBundles.hook) },
        builtAt: '2026-01-01T00:00:00.000Z',
        commit: 'test-commit',
        dirty: false,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('(b) registerGuard aplica as 4 regras de deny e o hook apontando pro versionDir instalado', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-install-b-'));
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-install-c-'));
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
        log: () => {},
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-install-d-'));
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
        log: () => {},
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
      expect(hexlogEntries[0].hooks[0].command).toContain('0.2.0');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('(e) mesma versão reinstalada com bundles diferentes troca atomicamente e avisa', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-install-e-'));
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
        log: () => {},
      });
      await installArtifact(argsFor(realBundles));
      const differentHook = Buffer.concat([
        realBundles.hook,
        Buffer.from('\n// different bytes\n'),
      ]);
      const result = await installArtifact(
        argsFor({ server: realBundles.server, hook: differentHook }),
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-install-f-'));
    try {
      const baseArgs = {
        home,
        version: '0.1.0',
        commit: null,
        dirty: false,
        clock: () => new Date(),
        log: () => {},
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

      // servidor preparado que não lista as 10 tools
      await expect(
        installArtifact({
          ...baseArgs,
          bundles: realBundles,
          runHook: runRealHookForInstall,
          verifyServer: () => Promise.resolve(9),
        }),
      ).rejects.toThrow(/9 tools/);
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
      expect(fs.readdirSync(path.join(home, '.local', 'lib', 'hexlog'))).toEqual(['0.1.0']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('(g) artefato instalado alterado por fora é reparado na execução seguinte', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-install-g-'));
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
        log: () => {},
      };
      const first = await installArtifact(args);
      const installedHookFile = path.join(first.versionDir, 'bash-guard.mjs');
      fs.writeFileSync(
        installedHookFile,
        Buffer.concat([realBundles.hook, Buffer.from('\n// alterado por fora\n')]),
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
    const sameHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-concurrency-same-'));
    try {
      const [r1, r2] = await Promise.all([
        runConcurrentFixture(sameHome, '0.1.0', 'x', 1, 2),
        runConcurrentFixture(sameHome, '0.1.0', 'x', 2, 2),
      ]);
      expect([r1.status, r2.status]).toEqual([0, 0]);
      expect(fs.readdirSync(versionDirOf(sameHome, '0.1.0')).sort()).toEqual([
        'bash-guard.mjs',
        'manifest.json',
        'server.mjs',
      ]);
    } finally {
      fs.rmSync(sameHome, { recursive: true, force: true });
    }

    const differentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-concurrency-different-'));
    try {
      const [r1, r2] = await Promise.all([
        runConcurrentFixture(differentHome, '0.1.0', 'x', 1, 2),
        runConcurrentFixture(differentHome, '0.1.0', 'y', 2, 2),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([0, 1]);
      const loser = r1.status === 1 ? r1 : r2;
      expect(loser.stdout).toContain('at the same time');
      expect(fs.readdirSync(versionDirOf(differentHome, '0.1.0')).sort()).toEqual([
        'bash-guard.mjs',
        'manifest.json',
        'server.mjs',
      ]);
    } finally {
      fs.rmSync(differentHome, { recursive: true, force: true });
    }
  }, 20_000);

  test('(h2) reinstalação concorrente: ENOENT no primeiro renameSync é tratado como concorrência, sem diretório misto', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-concurrency-reinstall-'));
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
        verifyServer: () => Promise.resolve(10),
        log: () => {},
      });

      const [r1, r2] = await Promise.all([
        runConcurrentFixture(home, '0.1.0', 'new', 1, 2),
        runConcurrentFixture(home, '0.1.0', 'new', 2, 2),
      ]);

      expect([r1.status, r2.status]).toEqual([0, 0]);
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
});

describe('B3: install.ts --check (processo real)', () => {
  let home: string;
  let version: string;

  beforeAll(() => {
    version = (
      JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-b3-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), buildSettingsTemplate(home));

    const installation = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/install.ts')], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        HEXLOG_REGISTER_MCP: path.join(repoRoot, 'test/fixtures/fake-mcp-install.ts'),
      },
    });
    if (installation.status !== 0) {
      throw new Error(
        `instalação real de baseline (B3) falhou: ${installation.stderr}\n${installation.stdout}`,
      );
    }
  }, 30_000);

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runCheck(opts: { cwd?: string } = {}): { status: number | null; stdout: string } {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/install.ts'), '--check'],
      {
        cwd: opts.cwd ?? repoRoot,
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      },
    );
    return { status: result.status, stdout: result.stdout };
  }

  test('instalação completa: exit 0, sem artifact-modified nem artifact-outdated', () => {
    const { status, stdout } = runCheck();
    expect(status).toBe(0);
    expect(stdout).not.toContain('artifact-modified');
    expect(stdout).not.toContain('artifact-outdated');
  }, 15_000);

  test('diretório da versão removido: hook-file, exit 1', () => {
    const versionDir = versionDirOf(home, version);
    const backup = `${versionDir}.backup-teste`;
    fs.renameSync(versionDir, backup);
    try {
      const { status, stdout } = runCheck();
      expect(status).toBe(1);
      expect(stdout).toContain('hook-file');
    } finally {
      fs.renameSync(backup, versionDir);
    }
  }, 15_000);

  test('bash-guard.mjs instalado editado, mas ainda nega/permite: artifact-modified, exit 1', () => {
    const hookFile = path.join(versionDirOf(home, version), 'bash-guard.mjs');
    const original = fs.readFileSync(hookFile);
    fs.writeFileSync(hookFile, Buffer.concat([original, Buffer.from('\n// comentário extra\n')]));
    try {
      const { status, stdout } = runCheck();
      expect(status).toBe(1);
      expect(stdout).toContain('artifact-modified');
    } finally {
      fs.writeFileSync(hookFile, original);
    }
  }, 15_000);

  test('quarta regra de deny ausente: deny-edit-lib, exit 1', () => {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const original = fs.readFileSync(settingsPath, 'utf8');
    const data = parseJson(SettingsSchema, original);
    const D = path.join(home, '.local', 'share', 'hexlog');
    const expected = expectedRules(D, home, process.execPath, version);
    data.permissions.deny = data.permissions.deny.filter((r: string) => r !== expected.denyEditLib);
    fs.writeFileSync(settingsPath, JSON.stringify(data));
    try {
      const { status, stdout } = runCheck();
      expect(status).toBe(1);
      expect(stdout).toContain('deny-edit-lib');
    } finally {
      fs.writeFileSync(settingsPath, original);
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
      const D = path.join(home, '.local', 'share', 'hexlog');
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
});
