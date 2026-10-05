import { describe, test, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTempDir } from './helpers.ts';
import { createEnvironment } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const hookPath = path.join(repoRoot, 'hook/bash-guard.ts');

// `HOME` temporário: D = <tmpHome>/.local/share/hexlog. Sem `XDG_DATA_HOME`
// no ambiente base, para os casos com `~` e `**` valerem contra esse D.
// Criados no `beforeAll`, não na coleta: a coleta roda até com `-t` e vazaria o diretório (#58).
let tmpHome: string;
let dataDir: string;
let cwdParentOfData: string;
let envBase: NodeJS.ProcessEnv;

// Bloco separado para o caso `${XDG_DATA_HOME}`: aqui D = <xdgTmp>/hexlog.
let dataDirXdg: string;
let envXdg: NodeJS.ProcessEnv;

beforeAll(() => {
  tmpHome = createTempDir('bash-guard');
  dataDir = path.join(tmpHome, '.local', 'share', 'hexlog');
  cwdParentOfData = path.dirname(dataDir);
  fs.mkdirSync(path.join(dataDir, 'p', 'r'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'p', 'r', 'events.jsonl'), '');

  envBase = { ...process.env, HOME: tmpHome };
  delete envBase.XDG_DATA_HOME;

  const xdgTmp = createTempDir('bash-guard-xdg');
  dataDirXdg = path.join(xdgTmp, 'hexlog');
  fs.mkdirSync(path.join(dataDirXdg, 'p', 'r'), { recursive: true });
  fs.writeFileSync(path.join(dataDirXdg, 'p', 'r', 'events.jsonl'), '');
  envXdg = { ...process.env, HOME: tmpHome, XDG_DATA_HOME: xdgTmp };
});

type HookInput = {
  command: string;
  cwd?: string;
};

function runHook(input: HookInput, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: input.command },
      ...(input.cwd ? { cwd: input.cwd } : {}),
    }),
    env,
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

type I4Case = {
  name: string;
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  class?: 'gap' | 'false-positive';
};

const denyCases: I4Case[] = [
  {
    name: 'absolute path to D',
    get command() {
      return `cat ${dataDir}/x`;
    },
  },
  { name: '~ expanded to D', command: 'cat ~/.local/share/hexlog/p/r/events.jsonl' },
  { name: '$HOME expanded by shell-quote', command: 'cat $HOME/.local/share/hexlog/x' },
  {
    name: 'empty double quotes mid-name (hex""log)',
    command: 'cat ~/.local/share/hex""log/x',
  },
  {
    name: 'command substitution: $(echo ~/...)',
    command: 'cat $(echo ~/.local/share/hexlog/x)',
  },
  {
    name: '/./ in the middle of the absolute path',
    get command() {
      return `cat /./${dataDir.slice(1)}/x`;
    },
  },
  {
    name: 'relative to D with cwd in D parent dir',
    command: 'cat hexlog/p/r/events.jsonl',
    get cwd() {
      return cwdParentOfData;
    },
  },
  {
    name: '--opt=<D>/x',
    get command() {
      return `--opt=${dataDir}/x`;
    },
  },
  { name: 'glob hex*', command: 'cat ~/.local/share/hex*/p/r/events.jsonl' },
  { name: 'glob hexl?g', command: 'cat ~/.local/share/hexl?g' },
  { name: 'brace {hexlog,x}', command: 'cat ~/.local/share/{hexlog,x}' },
  { name: 'character class [h]exlog', command: 'cat ~/.local/share/[h]exlog' },
  {
    name: 'glob * with cwd in D parent dir',
    command: 'cat */p/r/events.jsonl',
    get cwd() {
      return cwdParentOfData;
    },
  },
  {
    name: 'glob in the middle of the path (~/.local/*/hexlog/x)',
    command: 'cat ~/.local/*/hexlog/x',
  },
  {
    name: '** whose literal prefix is an ancestor of D (R-6)',
    command: 'cat ~/.local/**/events.jsonl',
  },
  {
    name: 'brace with slash inside ({hexlog/p/r/events.jsonl,x})',
    command: 'cat ~/.local/share/{hexlog/p/r/events.jsonl,x}',
  },
  {
    name: 'accepted false positive: ** whose prefix is an ancestor of D',
    command: 'ls ~/**/*.md',
    class: 'false-positive',
  },
];

const xdgCase: I4Case = {
  name: '${XDG_DATA_HOME} expanded by shell-quote',
  command: 'cat ${XDG_DATA_HOME}/hexlog/x',
  get env() {
    return envXdg;
  },
};

const allowCases: I4Case[] = [
  { name: 'ls in D parent dir', command: 'ls ~/.local/share' },
  { name: 'ls with shallow glob in D parent dir', command: 'ls ~/.local/*' },
  { name: 'find starting from ~ without citing D', command: "find ~ -name '*.jsonl'" },
  { name: 'Read outside D (~/.claude/projects)', command: 'cat ~/.claude/projects/x/y.jsonl' },
  { name: 'cd into the repo and run tests', command: `cd ${repoRoot} && npm test` },
  {
    name: '** inside the repository (not an ancestor of D)',
    command: `grep -rn x ${repoRoot}/**/*.ts`,
  },
  {
    name: 'gap: cd + relative path in separate commands',
    command: 'cd ~/.local/share && cat hexlog/p/r/events.jsonl',
    class: 'gap',
  },
  {
    name: 'gap: grep -r in D parent dir',
    command: 'grep -r foo ~/.local/share/',
    class: 'gap',
  },
  {
    name: 'gap: variable assigned in the same command',
    command: 'd=~/.local/share; cat $d/hexlog/x',
    class: 'gap',
  },
  {
    name: "gap: ANSI-C quoting ($'...\\x6c...')",
    get command() {
      return `cat $'${tmpHome}/.local/share/hex\\x6cog/x'`;
    },
    class: 'gap',
  },
  {
    name: 'gap: zsh alternation ((hexlog|x))',
    command: 'cat ~/.local/share/(hexlog|x)/p/r/events.jsonl',
    class: 'gap',
  },
];

describe('bash-guard (I4): nega o acesso a D por Bash', () => {
  for (const testCase of denyCases) {
    test(`${testCase.name}`, () => {
      const result = runHook(testCase, testCase.env ?? envBase);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('is only accessible through the hexlog MCP tools');
    });
  }

  test(`${xdgCase.name}`, () => {
    const result = runHook(xdgCase, xdgCase.env!);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(dataDirXdg);
  });

  test('mensagem de deny completa cita os nomes novos das tools de leitura', () => {
    const result = runHook({ command: `cat ${dataDir}/x` }, envBase);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      `hexlog: ${dataDir} is only accessible through the hexlog MCP tools (list, query, verify_chain, read_attachment, evaluate_gate).`,
    );
  });

  test('as tools citadas na mensagem são exatamente as que o servidor anuncia com readOnlyHint', async () => {
    const environment = await createEnvironment();
    try {
      const { tools } = await environment.client.listTools();
      const readOnly = tools
        .filter(({ annotations }) => annotations?.readOnlyHint === true)
        .map(({ name }) => name);

      const { stderr } = runHook({ command: `cat ${dataDir}/x` }, envBase);

      const cited = /\(([^()]*)\)\.$/.exec(stderr)?.[1]?.split(', ');
      expect(cited?.sort()).toEqual(readOnly.sort());
    } finally {
      await environment.close();
    }
  });
});

describe('bash-guard (I4): permite o que não alcança D', () => {
  for (const testCase of allowCases) {
    test(`${testCase.name}`, () => {
      const result = runHook(testCase, testCase.env ?? envBase);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });
  }
});

describe('bash-guard (I7): entrada inválida ou exceção interna falha aberto', () => {
  test('stdin vazio → exit 0 sem saída', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: '',
      env: envBase,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  test('JSON inválido → exit 0 sem saída', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: '{this is not json',
      env: envBase,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('tool_name diferente de Bash → exit 0 sem saída', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: dataDir } }),
      env: envBase,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('tool_input sem command → exit 0 sem saída', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
      env: envBase,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('shell-quote.parse lançando: decide só pela checagem literal (contém D → nega)', () => {
    const result = runHook({ command: `cat \${} ${dataDir}/x` }, envBase);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is only accessible through the hexlog MCP tools');
  });

  test('shell-quote.parse lançando: decide só pela checagem literal (sem D → permite)', () => {
    const result = runHook({ command: 'cat ${} /tmp/something-unrelated' }, envBase);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});

describe('B1(b): hook empacotado pelo esbuild', () => {
  let bundle: string;

  beforeAll(() => {
    const outdirBundle = createTempDir('bash-guard-bundle');
    bundle = path.join(outdirBundle, 'bash-guard.mjs');

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
  });

  test('nega cat <D>/x (exit 2) e permite true (exit 0)', () => {
    const denyResult = spawnSync(process.execPath, [bundle], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cat ${dataDir}/x` } }),
      env: envBase,
      encoding: 'utf8',
    });
    expect(denyResult.status).toBe(2);
    expect(denyResult.stderr).toContain('is only accessible through the hexlog MCP tools');

    const allowResult = spawnSync(process.execPath, [bundle], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } }),
      env: envBase,
      encoding: 'utf8',
    });
    expect(allowResult.status).toBe(0);
    expect(allowResult.stderr).toBe('');
  });

  test('o bundle não contém o shim "Dynamic require of"', () => {
    const bytes = fs.readFileSync(bundle);
    expect(bytes.includes('Dynamic require of')).toBe(false);
  });
});

describe('latência (informativo, sem asserção rígida)', () => {
  test('média de 10 execuções do hook .ts', () => {
    const durations: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const start = performance.now();
      runHook({ command: 'true' }, envBase);
      durations.push(performance.now() - start);
    }
    const average = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
    console.log(`hook/bash-guard.ts: average of 10 runs = ${average.toFixed(1)} ms`);
    expect(durations).toHaveLength(10);
  });
});
