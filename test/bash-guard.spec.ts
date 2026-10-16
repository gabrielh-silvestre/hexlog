import { describe, test, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapeRegExp } from 'es-toolkit';
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
    timeout: 8000,
  });
}

function runThroughSymlink(target: string) {
  const link = path.join(createTempDir('bash-guard-link'), path.basename(target));
  fs.symlinkSync(target, link);
  return spawnSync(process.execPath, [link], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cat ${dataDir}/x` } }),
    env: envBase,
    encoding: 'utf8',
    timeout: 8000,
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
  {
    name: 'brace range inside the name (hex{a..z}log)',
    command: 'cat ~/.local/share/hex{a..z}log',
  },
  {
    name: 'brace over a hidden segment ({.local,x})',
    command: 'cat ~/{.local,x}/share/hexlog/.v1/a',
  },
  {
    name: 'brace over a hidden segment that is too big to expand ({.local,x} plus a range)',
    command: 'cat ~/{.local,x}/share/hexlog{a..c}',
  },
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
  { name: 'numeric brace range far from D', command: 'ls {1..10000}' },
  {
    name: 'brace in the last component of D parent dir',
    command: 'mkdir -p ~/.local/share/{foo,bar}',
  },
  { name: 'brace in the middle component of a glob', command: 'ls ~/.local/{bin,lib}/*' },
  { name: 'awk program with braces', command: "awk '{print $1}' file.txt" },
  { name: 'plain ls -la', command: 'ls -la' },
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
    }, 15_000);
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
      `hexlog: ${dataDir} is only accessible through the hexlog MCP tools (list, query, verify_chain, read_attachment, evaluate_gate, describe_type).`,
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
    }, 15_000);
  }
});

describe('bash-guard (I7): entrada inválida falha aberto', () => {
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
  }, 15_000);
});

describe('bash-guard (U1): hostile tokens are denied, not released', () => {
  const reachesMessage = 'is only accessible through the hexlog MCP tools';
  const undecidableMessage = 'was denied only because it exceeds a safety limit';
  // Trecho final com `~`: o `includes` literal de D não o vê, então só o teto ou o orçamento
  // sob teste decide antes dele (sem o teto, o hook estoura o timeout e o status não é 2).
  const homeTail = '; cat ~/.local/share/hexlog/x';
  const hostileCases: { name: string; command: string; stderr: string }[] = [
    {
      name: 'denies a 64 KiB token of "?" followed by a command reaching D through "~"',
      command: `cat ${'?'.repeat(65536)}${homeTail}`,
      stderr: undecidableMessage,
    },
    {
      name: 'denies a 64 KiB token of "[" without hitting the hook timeout',
      command: `cat ${'['.repeat(65536)}`,
      stderr: undecidableMessage,
    },
    {
      name: 'denies a token with 14 brace groups without hitting the hook timeout',
      command: `cat ${'{a,b}'.repeat(14)}`,
      stderr: undecidableMessage,
    },
    {
      name: 'denies a 4097-character glob token',
      command: `cat ${'?'.repeat(4097)}`,
      stderr: undecidableMessage,
    },
    {
      name: 'denies a token with 65 opening brackets',
      command: `cat ${'['.repeat(65)}`,
      stderr: undecidableMessage,
    },
    {
      name: 'denies a numeric brace range followed by a command reaching D through "~"',
      command: `cat {1..9999999}${homeTail}`,
      stderr: reachesMessage,
    },
    {
      name: 'denies 7 groups of {a,b,c,d} followed by a command reaching D through "~"',
      command: `ls ${'{a,b,c,d}'.repeat(7)}${homeTail}`,
      stderr: reachesMessage,
    },
    {
      name: 'denies 1000 tokens of {1..30}{1..30} followed by a command reaching D through "~"',
      command: `ls ${Array(1000).fill('{1..30}{1..30}').join(' ')}${homeTail}`,
      stderr: reachesMessage,
    },
    {
      name: 'denies 500 tokens of "{" plus 4000 "/" (sum of glob tokens above the budget)',
      command: `ls ${Array(500)
        .fill(`{${'/'.repeat(4000)}`)
        .join(' ')}${homeTail}`,
      stderr: undecidableMessage,
    },
    {
      name: 'denies a command above the length limit even without glob characters',
      command: `echo ${'a'.repeat(1_048_577)}`,
      stderr: undecidableMessage,
    },
    {
      name: 'denies 5000 small glob tokens (sum above the budget) even without citing D',
      command: `ls ${Array(5000).fill('*a*a*a*a*a*b').join(' ')}`,
      stderr: undecidableMessage,
    },
  ];

  for (const testCase of hostileCases) {
    test(`${testCase.name}`, () => {
      const result = runHook(testCase, envBase);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(testCase.stderr);
    }, 15_000);
  }

  // Lado "no teto" de cada constante: um `>` trocado por `>=` no hook derrubaria estes casos.
  const ceilingCases: { name: string; command: string }[] = [
    { name: 'a glob token of exactly 4096 characters', command: `cat ${'?'.repeat(4096)}` },
    { name: 'a token with exactly 64 opening brackets', command: `cat ${'['.repeat(64)}` },
    { name: 'a token with exactly 8 brace groups', command: `cat ${'{a,b}'.repeat(8)}` },
    {
      name: 'glob tokens summing exactly 16384 characters',
      command: `ls ${Array(4).fill('?'.repeat(4096)).join(' ')}`,
    },
    {
      name: 'a command of exactly 1 MiB',
      command: `echo ${'a'.repeat(1_048_576 - 'echo '.length)}`,
    },
    {
      name: 'a token under ~/.local/share/ with exactly 32 brace alternatives',
      command: `ls ~/.local/share/${'{a,b}'.repeat(5)}`,
    },
  ];

  for (const testCase of ceilingCases) {
    test(`allows ${testCase.name}`, () => {
      const result = runHook(testCase, envBase);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }, 15_000);
  }

  test('denies a token under ~/.local/share/ with 64 brace alternatives (above the 32 limit)', () => {
    const result = runHook({ command: `ls ~/.local/share/${'{a,b}'.repeat(6)}` }, envBase);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(reachesMessage);
  }, 15_000);

  test('does not mention D when the denial is for an undecidable command', () => {
    const result = runHook({ command: `cat ${'['.repeat(65)}` }, envBase);
    expect(result.stderr).not.toContain(dataDir);
  }, 15_000);

  test('allows a command shell-quote cannot parse when it does not cite D', () => {
    const result = runHook({ command: 'echo ${}; cat ~/.local/share/hex""log/x' }, envBase);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  }, 15_000);

  test('allows a 5000-character token without glob characters', () => {
    const result = runHook({ command: `echo ${'a'.repeat(5000)}` }, envBase);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  }, 15_000);
});

describe('bash-guard (#158): ceilings apply only to tokens the shell expands', () => {
  const reachesMessage = 'is only accessible through the hexlog MCP tools';
  const costMessage = 'does not cite the hexlog data directory literally';
  const script = `${'{'.repeat(20)}${'['.repeat(100)}`;
  // Glob que casa D (glob no último segmento do HOME) e passa do teto de comprimento: sem a
  // checagem de custo, um `cat` dele leria D.
  // Prefixo de `find -path` sem citar D literalmente: o glob começa no último segmento do HOME.
  const findPrefix = () => `${tmpHome.slice(0, -1)}*/.local/share/hex*`;
  const bigGlob = () => `${tmpHome.slice(0, -1)}*/.local/share/hexlog${'/'.repeat(5000)}p/*`;

  const allowedCases: { name: string; command: string }[] = [
    {
      name: 'a single-quoted node -e script with 20 braces and 100 brackets',
      command: `node -e '${script}'`,
    },
    {
      name: 'a double-quoted python -c script with 20 braces and 100 brackets',
      command: `python -c "${script}"`,
    },
    {
      name: 'a quoted script above the length ceiling and the glob budget',
      command: `node -e '${script}${'a'.repeat(20_000)}'`,
    },
    { name: 'backslash-escaped brackets', command: `cat ${'\\['.repeat(100)}` },
    {
      name: 'a quoted script followed by an unquoted command that does not reach D',
      command: `node -e '${script}' && ls -la`,
    },
    {
      name: 'a double-quoted script with an escaped quote before the brackets',
      command: `node -e "a\\"${'['.repeat(100)}"`,
    },
  ];

  for (const testCase of allowedCases) {
    test(`allows ${testCase.name}`, () => {
      const result = runHook(testCase, envBase);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }, 15_000);
  }

  const deniedCases: { name: string; command: string; cwd?: string; stderr: string }[] = [
    {
      // shell-quote 1.12 decodifica o escape ANSI-C; na 1.10 isto era uma lacuna aceita
      name: "an ANSI-C quoted path whose escape spells D ($'...\\x6c...')",
      get command() {
        return `cat $'${tmpHome}/.local/share/hex\\x6cog/x'`;
      },
      stderr: reachesMessage,
    },
    {
      name: 'a quoted script that cites D',
      get command() {
        return `node -e '${script} ${dataDir}'`;
      },
      stderr: reachesMessage,
    },
    {
      name: 'a quoted token above the ceilings that reaches D through "~"',
      command: `cat '~/.local/share/hexlog/x${'['.repeat(100)}'`,
      stderr: reachesMessage,
    },
    {
      name: 'a quoted relative token above the ceilings that resolves inside D',
      command: `cat "hexlog/${'['.repeat(100)}"`,
      cwd: 'PARENT_OF_D',
      stderr: reachesMessage,
    },
    {
      name: 'a quoted find -path pattern padded with 5000 "*" whose literal prefix is an ancestor of D',
      get command() {
        return `find / -path '${findPrefix()}/.v1/${'*'.repeat(5000)}records.jsonl' -exec cat {} +`;
      },
      stderr: reachesMessage,
    },
    {
      name: 'a quoted find -path pattern with 9 brace groups whose literal prefix is an ancestor of D',
      get command() {
        return `find / -path '${findPrefix()}/${'{a,b}'.repeat(9)}'`;
      },
      stderr: reachesMessage,
    },
    {
      name: 'a quoted find -path pattern with 65 bracket classes whose literal prefix is an ancestor of D',
      get command() {
        return `find / -path '${findPrefix()}/${'[a]'.repeat(65)}'`;
      },
      stderr: reachesMessage,
    },
    {
      name: 'an unquoted token with 20 opening braces',
      command: `cat ${'{'.repeat(20)}`,
      stderr: costMessage,
    },
    {
      name: 'an unquoted token with 100 opening brackets',
      command: `cat ${'['.repeat(100)}`,
      stderr: costMessage,
    },
    {
      name: 'a mixed token, quoted brackets followed by an unquoted "*"',
      command: `cat '${'['.repeat(100)}'*`,
      stderr: costMessage,
    },
    {
      name: 'a mixed token, a quoted prefix followed by 14 unquoted brace groups',
      command: `cat "x"${'{a,b}'.repeat(14)}`,
      stderr: costMessage,
    },
    {
      name: 'a mixed token, an unquoted "*" followed by quoted brackets',
      command: `cat *"${'['.repeat(100)}"`,
      stderr: costMessage,
    },
    {
      name: 'an ANSI-C quoted token above the ceilings (the quote tracker does not model it)',
      command: `node -e $'${'['.repeat(100)}'`,
      stderr: costMessage,
    },
    {
      name: 'a heredoc body above the ceilings',
      command: `cat <<'EOF'\n${'['.repeat(100)}\nEOF`,
      stderr: costMessage,
    },
    {
      name: 'an unterminated quote, where the shell-quote splits the token and the masked command merges it',
      command: `node -e '${'['.repeat(100)}\n--flag`,
      stderr: costMessage,
    },
  ];

  // Cada comando põe, depois de uma construção que o rastreador de aspas do `maskQuoted` não
  // modela como o bash, um glob que casa D acima dos tetos; o bash o expande e lê D.
  const desyncPrefixes: { name: string; prefix: string }[] = [
    { name: 'an ANSI-C quote with an escaped apostrophe', prefix: String.raw`cat $'a\'b' ` },
    {
      name: 'a command substitution with quotes inside double quotes',
      prefix: String.raw`echo x\\ "\"" "$(echo 'a"b')" && cat `,
    },
    {
      name: 'an ANSI-C quote after a command substitution on the previous line',
      prefix: String.raw`echo "\\" $'a\'b' $(echo 1) "\\"` + '\ncat ',
    },
    {
      name: 'a heredoc with a lone double quote in its body',
      prefix: String.raw`echo "\\"'' <<'E'` + '\n"\nE\n"a" ; cat ',
    },
    {
      name: 'a locale-translated string and an ANSI-C quote',
      prefix: String.raw`echo $"a\"b" x\\ $'\''` + '\ncat ',
    },
    { name: 'no quotes at all (control)', prefix: 'cat ' },
  ];

  for (const { name, prefix } of desyncPrefixes) {
    test(`denies for cost a D-matching glob above the ceilings after ${name}`, () => {
      const result = runHook({ command: `${prefix}${bigGlob()}` }, envBase);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(costMessage);
    }, 15_000);
  }

  for (const testCase of deniedCases) {
    test(`denies ${testCase.name}`, () => {
      const cwd = testCase.cwd === 'PARENT_OF_D' ? cwdParentOfData : undefined;
      const result = runHook({ command: testCase.command, cwd }, envBase);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(testCase.stderr);
    }, 15_000);
  }

  test('keeps matching a quoted glob under the ceilings against D', () => {
    const result = runHook({ command: `find / -path '${tmpHome}/.local/share/hex*'` }, envBase);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(reachesMessage);
  }, 15_000);

  test('says the command does not cite D and was denied only for cost', () => {
    const result = runHook({ command: `cat ${'['.repeat(100)}` }, envBase);
    expect(result.stderr).toContain(costMessage);
    expect(result.stderr).toContain('was denied only because it exceeds a safety limit');
    expect(result.stderr).not.toContain(dataDir);
  }, 15_000);

  test('does not tell the user to quote text that the glob budget still sums', () => {
    const result = runHook({ command: `cat ${'['.repeat(100)}` }, envBase);
    expect(result.stderr).not.toMatch(/quote/i);
  }, 15_000);

  test('still sums quoted glob tokens under the ceilings in the command budget', () => {
    const result = runHook(
      { command: `ls ${Array(5000).fill("'*a*a*a*a*b'").join(' ')}` },
      envBase,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(costMessage);
  }, 15_000);
});

describe('bash-guard (#45): a mensagem cita o trecho que casou', () => {
  test('names the matched segment when a compound command reaches D', () => {
    const result = runHook({ command: `ls /tmp && cat ${dataDir}/x` }, envBase);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(new RegExp(`Matched: cat ${escapeRegExp(dataDir)}/x$`));
  }, 15_000);

  test('names the rejected token when a token is oversized', () => {
    const token = '['.repeat(100);
    const result = runHook({ command: `true ; cat ${token}` }, envBase);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(new RegExp(`Matched: cat ${escapeRegExp(token)}$`));
  }, 15_000);

  test.each(['&', '|&'])(
    'treats "%s" as a segment separator',
    (operator) => {
      const token = '['.repeat(100);
      const result = runHook({ command: `true ${operator} cat ${token}` }, envBase);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(new RegExp(`Matched: cat ${escapeRegExp(token)}$`));
    },
    15_000,
  );

  test('replaces control characters in the matched segment with "?"', () => {
    const token = `${'['.repeat(100)}\u0007\u001b`;
    const result = runHook({ command: `true ; cat ${token}` }, envBase);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Matched: cat \[+\?\?$/);
  }, 15_000);

  test('replaces format and line separator characters in the matched segment with "?"', () => {
    const token = `${'['.repeat(100)}\u202e\u200b\u2028`;
    const result = runHook({ command: `true ; cat "${token}"*` }, envBase);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Matched: cat \[+\?\?\?\*$/);
  }, 15_000);

  test('truncates the matched segment to 200 characters', () => {
    const result = runHook({ command: `true ; cat ${'['.repeat(300)}` }, envBase);
    expect(result.stderr).toMatch(/Matched: cat \[+$/);
    expect(result.stderr.split('Matched: ')[1]).toHaveLength(200);
  }, 15_000);

  test('does not add a matched segment to a simple command', () => {
    const result = runHook({ command: `cat ${dataDir}/x` }, envBase);
    expect(result.stderr).not.toContain('Matched:');
  }, 15_000);
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

  test('denies when the bundled hook runs through a symlink', () => {
    const result = runThroughSymlink(bundle);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is only accessible through the hexlog MCP tools');
  }, 15_000);

  test('o bundle não contém o shim "Dynamic require of"', () => {
    const bytes = fs.readFileSync(bundle);
    expect(bytes.includes('Dynamic require of')).toBe(false);
  });
});

describe('bash-guard (M2): entrypoint resolvido por realpath', () => {
  test('denies when run through a symlink to the hook', () => {
    const result = runThroughSymlink(hookPath);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is only accessible through the hexlog MCP tools');
  }, 15_000);
});
