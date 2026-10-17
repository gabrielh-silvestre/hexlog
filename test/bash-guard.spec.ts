import { beforeAll, describe, expect, it } from '@jest/globals';
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

function prepareEnvironment(): void {
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
}

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

/** Roda o hook e confere a recusa: exit 2 e `stderrPart` no stderr. */
function expectDenied(input: HookInput, env: NodeJS.ProcessEnv, stderrPart: string): void {
  const result = runHook(input, env);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain(stderrPart);
}

/** Roda o hook e confere a liberação: exit 0 e stderr vazio. */
function expectAllowed(input: HookInput, env: NodeJS.ProcessEnv): void {
  const result = runHook(input, env);

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
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
  {
    name: 'gap: locale-translated string inside the name',
    command: 'cat ~/.local/share/he$"x"log/x',
    class: 'gap',
  },
];

describe('hook/bash-guard.ts', () => {
  beforeAll(prepareEnvironment);

  describe('when the command reaches D', () => {
    it.each(denyCases)(
      'should deny $name (I4)',
      (testCase) => {
        expectDenied(
          testCase,
          testCase.env ?? envBase,
          'is only accessible through the hexlog MCP tools',
        );
      },
      15_000,
    );

    it(`should deny ${xdgCase.name} (I4)`, () => {
      expectDenied(xdgCase, xdgCase.env!, dataDirXdg);
    });

    it('should cite the new names of the read tools in the complete deny message (I4)', () => {
      const result = runHook({ command: `cat ${dataDir}/x` }, envBase);

      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        `hexlog: ${dataDir} is only accessible through the hexlog MCP tools (list, query, verify_chain, read_attachment, evaluate_gate, describe_type).`,
      );
    });

    it('should cite exactly the tools that the server advertises with readOnlyHint (I4)', async () => {
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

  describe('when the command does not reach D', () => {
    it.each(allowCases)(
      'should allow $name (I4)',
      (testCase) => {
        expectAllowed(testCase, testCase.env ?? envBase);
      },
      15_000,
    );
  });

  describe('with invalid input', () => {
    it('should exit 0 without output for an empty stdin (I7)', () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: '',
        env: envBase,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('should exit 0 without output for an invalid JSON (I7)', () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: '{this is not json',
        env: envBase,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('should exit 0 without output when tool_name is not Bash (I7)', () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: dataDir } }),
        env: envBase,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('should exit 0 without output when tool_input has no command (I7)', () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
        env: envBase,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('should decide only by the literal check when shell-quote.parse throws, denying a command that contains D (I7)', () => {
      expectDenied(
        { command: `cat \${} ${dataDir}/x` },
        envBase,
        'is only accessible through the hexlog MCP tools',
      );
    }, 15_000);
  });

  describe('with hostile tokens', () => {
    const reachesMessage = 'is only accessible through the hexlog MCP tools';
    const undecidableMessage = 'was denied only because it exceeds a safety limit';
    // Trecho final com `~`: o `includes` literal de D não o vê, então só o teto ou o orçamento
    // sob teste decide antes dele (sem o teto, o hook estoura o timeout e o status não é 2).
    const homeTail = '; cat ~/.local/share/hexlog/x';
    const hostileCases: { name: string; command: string; stderr: string }[] = [
      {
        name: 'a 64 KiB token of "?" followed by a command reaching D through "~"',
        command: `cat ${'?'.repeat(65536)}${homeTail}`,
        stderr: undecidableMessage,
      },
      {
        name: 'a 64 KiB token of "[" without hitting the hook timeout',
        command: `cat ${'['.repeat(65536)}`,
        stderr: undecidableMessage,
      },
      {
        name: 'a token with 14 brace groups without hitting the hook timeout',
        command: `cat ${'{a,b}'.repeat(14)}`,
        stderr: undecidableMessage,
      },
      {
        name: 'a 4097-character glob token',
        command: `cat ${'?'.repeat(4097)}`,
        stderr: undecidableMessage,
      },
      {
        name: 'a token with 65 opening brackets',
        command: `cat ${'['.repeat(65)}`,
        stderr: undecidableMessage,
      },
      {
        name: 'a numeric brace range followed by a command reaching D through "~"',
        command: `cat {1..9999999}${homeTail}`,
        stderr: reachesMessage,
      },
      {
        name: '7 groups of {a,b,c,d} followed by a command reaching D through "~"',
        command: `ls ${'{a,b,c,d}'.repeat(7)}${homeTail}`,
        stderr: reachesMessage,
      },
      {
        name: '1000 tokens of {1..30}{1..30} followed by a command reaching D through "~"',
        command: `ls ${Array(1000).fill('{1..30}{1..30}').join(' ')}${homeTail}`,
        stderr: reachesMessage,
      },
      {
        name: '500 tokens of "{" plus 4000 "/" (sum of glob tokens above the budget)',
        command: `ls ${Array(500)
          .fill(`{${'/'.repeat(4000)}`)
          .join(' ')}${homeTail}`,
        stderr: undecidableMessage,
      },
      {
        name: 'a command above the length limit even without glob characters',
        command: `echo ${'a'.repeat(1_048_577)}`,
        stderr: undecidableMessage,
      },
      {
        name: '5000 small glob tokens (sum above the budget) even without citing D',
        command: `ls ${Array(5000).fill('*a*a*a*a*a*b').join(' ')}`,
        stderr: undecidableMessage,
      },
    ];

    it.each(hostileCases)(
      'should deny $name (U1)',
      (testCase) => {
        expectDenied(testCase, envBase, testCase.stderr);
      },
      15_000,
    );

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

    it.each(ceilingCases)(
      'should allow $name (U1)',
      (testCase) => {
        expectAllowed(testCase, envBase);
      },
      15_000,
    );

    it('should deny a token under ~/.local/share/ with 64 brace alternatives, above the 32 limit (U1)', () => {
      expectDenied({ command: `ls ~/.local/share/${'{a,b}'.repeat(6)}` }, envBase, reachesMessage);
    }, 15_000);

    it('should not mention D when the denial is for an undecidable command (U1)', () => {
      const result = runHook({ command: `cat ${'['.repeat(65)}` }, envBase);

      expect(result.stderr).not.toContain(dataDir);
    }, 15_000);

    it('should allow a command that shell-quote cannot parse when it does not cite D (U1)', () => {
      expectAllowed({ command: 'echo ${}; cat ~/.local/share/hex""log/x' }, envBase);
    }, 15_000);

    it('should allow a 5000-character token without glob characters (U1)', () => {
      expectAllowed({ command: `echo ${'a'.repeat(5000)}` }, envBase);
    }, 15_000);
  });

  describe('with tokens above the ceilings', () => {
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

    it.each(allowedCases)(
      'should allow $name (#158)',
      (testCase) => {
        expectAllowed(testCase, envBase);
      },
      15_000,
    );

    const deniedCases: { name: string; command: string; cwd?: string; stderr: string }[] = [
      {
        // shell-quote >=1.11 decodifica o escape ANSI-C; na 1.10 isto era uma lacuna aceita
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
        // Falso positivo aceito (`hooks-sao-freios`): o prefixo literal do token, resolvido contra um
        // `cwd` pai de D, alcança D mesmo sem citá-lo; um script comum acima dos tetos sai negado.
        name: 'accepted false positive: a quoted node -e script above the ceilings with cwd in D parent dir',
        command: `node -e '${script}'`,
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

    it.each(desyncPrefixes)(
      'should deny for cost a D-matching glob above the ceilings after $name (#158)',
      ({ prefix }) => {
        expectDenied({ command: `${prefix}${bigGlob()}` }, envBase, costMessage);
      },
      15_000,
    );

    it.each(deniedCases)(
      'should deny $name (#158)',
      (testCase) => {
        const cwd = testCase.cwd === 'PARENT_OF_D' ? cwdParentOfData : undefined;

        expectDenied({ command: testCase.command, cwd }, envBase, testCase.stderr);
      },
      15_000,
    );

    it('should keep matching a quoted glob under the ceilings against D (#158)', () => {
      expectDenied(
        { command: `find / -path '${tmpHome}/.local/share/hex*'` },
        envBase,
        reachesMessage,
      );
    }, 15_000);

    it('should say the command does not cite D and was denied only for cost (#158)', () => {
      const result = runHook({ command: `cat ${'['.repeat(100)}` }, envBase);

      expect(result.stderr).toContain(costMessage);
      expect(result.stderr).toContain('was denied only because it exceeds a safety limit');
      expect(result.stderr).not.toContain(dataDir);
    }, 15_000);

    it('should not tell the user to quote text that the glob budget still sums (#158)', () => {
      const result = runHook({ command: `cat ${'['.repeat(100)}` }, envBase);

      expect(result.stderr).not.toMatch(/quote/i);
    }, 15_000);

    it('should still sum quoted glob tokens under the ceilings in the command budget (#158)', () => {
      expectDenied(
        { command: `ls ${Array(5000).fill("'*a*a*a*a*b'").join(' ')}` },
        envBase,
        costMessage,
      );
    }, 15_000);

    it('should measure a quoted "~" token after the expansion, as the classification does', () => {
      // 4096 caracteres crus (no teto), mais que o teto depois de expandir o `~`; entre aspas, o
      // shell não o expande, então só o caminho e o prefixo literais contam.
      const result = runHook({ command: `cat '~/sub/${'a'.repeat(4089)}*'` }, envBase);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }, 15_000);

    it('should deny by literal prefix, not by cost, a quoted "~" token over the ceiling once expanded', () => {
      // O prefixo literal `~` é ancestral de D: nega por alcançar D, não por teto de custo.
      const result = runHook({ command: `cat '~/${'a'.repeat(4093)}*'` }, envBase);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(reachesMessage);
    }, 15_000);
  });

  describe('with text after a "#"', () => {
    const reachesMessage = 'is only accessible through the hexlog MCP tools';
    // Glob que alcança D por `~`: o `includes` literal de D não o vê, só a checagem dos tokens.
    const globToD = '~/.local/share/hex*/x';

    it.each([
      {
        name: 'a comment line followed by a line break and a glob reaching D',
        command: `echo hi # x\ncat ${globToD}`,
      },
      {
        name: 'a "#" in the middle of a word followed by ";" and a glob reaching D',
        command: `echo a#b; cat ${globToD}`,
      },
      {
        name: 'a comment with a stray quote followed by a line break and a glob',
        command: `echo hi # don't\ncat ${globToD}`,
      },
      {
        name: 'a glob reaching D after a second "#" on the same line',
        command: `echo hi # a # cat ${globToD}`,
      },
      {
        name: 'a glob reaching D before a comment holding a line the shell-quote cannot parse',
        command: `cat ${globToD} # \${}`,
      },
      {
        name: 'a comment line the shell-quote cannot parse followed by a line break and a glob',
        command: `echo hi # \${}\ncat ${globToD}`,
      },
    ])(
      'should deny $name (#180)',
      ({ command }) => {
        const result = runHook({ command }, envBase);

        expect(result.status).toBe(2);
        expect(result.stderr).toContain(reachesMessage);
      },
      15_000,
    );

    it.each([
      { name: 'a trailing comment', command: 'echo hi # done' },
      { name: 'a comment line followed by a glob outside D', command: 'echo hi # x\ncat /tmp/*' },
      {
        name: 'a "#" in the middle of a word followed by a command outside D',
        command: 'echo a#b; ls /tmp',
      },
    ])(
      'should allow $name (#180)',
      ({ command }) => {
        const result = runHook({ command }, envBase);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
      },
      15_000,
    );

    it('should deny a glob reaching D after 900 thousand line breaks inside a comment (#180)', () => {
      const result = runHook(
        { command: `echo hi #${'\n'.repeat(900_000)}cat ${globToD}` },
        envBase,
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(reachesMessage);
    }, 15_000);
  });

  describe('when the denial cites the matched segment', () => {
    it('should name the matched segment when a compound command reaches D (#45)', () => {
      const result = runHook({ command: `ls /tmp && cat ${dataDir}/x` }, envBase);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(new RegExp(`Matched: cat ${escapeRegExp(dataDir)}/x$`));
    }, 15_000);

    it('should name the rejected token when a token is oversized (#45)', () => {
      const token = '['.repeat(100);

      const result = runHook({ command: `true ; cat ${token}` }, envBase);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(new RegExp(`Matched: cat ${escapeRegExp(token)}$`));
    }, 15_000);

    it.each(['&', '|&'])(
      'should treat "%s" as a segment separator (#45)',
      (operator) => {
        const token = '['.repeat(100);

        const result = runHook({ command: `true ${operator} cat ${token}` }, envBase);

        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(new RegExp(`Matched: cat ${escapeRegExp(token)}$`));
      },
      15_000,
    );

    it('should replace control characters in the matched segment with "?" (#45)', () => {
      const token = `${'['.repeat(100)}\u0007\u001b`;

      const result = runHook({ command: `true ; cat ${token}` }, envBase);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/Matched: cat \[+\?\?$/);
    }, 15_000);

    it('should replace format and line separator characters in the matched segment with "?" (#45)', () => {
      const token = `${'['.repeat(100)}\u202e\u200b\u2028`;

      const result = runHook({ command: `true ; cat "${token}"*` }, envBase);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/Matched: cat \[+\?\?\?\*$/);
    }, 15_000);

    it('should truncate the matched segment to 200 characters (#45)', () => {
      const result = runHook({ command: `true ; cat ${'['.repeat(300)}` }, envBase);

      expect(result.stderr).toMatch(/Matched: cat \[+$/);
      expect(result.stderr.split('Matched: ')[1]).toHaveLength(200);
    }, 15_000);

    it('should not add a matched segment to a simple command (#45)', () => {
      const result = runHook({ command: `cat ${dataDir}/x` }, envBase);

      expect(result.stderr).not.toContain('Matched:');
    }, 15_000);
  });

  it('should deny when run through a symlink to the hook (M2)', () => {
    const result = runThroughSymlink(hookPath);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is only accessible through the hexlog MCP tools');
  }, 15_000);
});

describe('dist/bash-guard.mjs', () => {
  let bundle: string;

  beforeAll(prepareEnvironment);

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

  it('should deny cat <D>/x with exit 2 (B1(b))', () => {
    const result = spawnSync(process.execPath, [bundle], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cat ${dataDir}/x` } }),
      env: envBase,
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is only accessible through the hexlog MCP tools');
  });

  it('should allow true with exit 0 (B1(b))', () => {
    const result = spawnSync(process.execPath, [bundle], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } }),
      env: envBase,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('should deny when the bundled hook runs through a symlink (B1(b))', () => {
    const result = runThroughSymlink(bundle);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is only accessible through the hexlog MCP tools');
  }, 15_000);

  it('should not contain the "Dynamic require of" shim (B1(b))', () => {
    const bytes = fs.readFileSync(bundle);

    expect(bytes.includes('Dynamic require of')).toBe(false);
  });
});
