import { describe, test, expect, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const raizDoRepo = path.resolve(__dirname, '..');
const caminhoDoHook = path.join(raizDoRepo, 'hook/bash-guard.ts');

// `HOME` temporário: D = <tmpHome>/.local/share/hexlog. Sem `XDG_DATA_HOME`
// no ambiente base, para os casos com `~` e `**` valerem contra esse D.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-guarda-bash-'));
const dadosDir = path.join(tmpHome, '.local', 'share', 'hexlog');
const cwdPaiDeDados = path.dirname(dadosDir);
fs.mkdirSync(path.join(dadosDir, 'p', 'r'), { recursive: true });
fs.writeFileSync(path.join(dadosDir, 'p', 'r', 'eventos.jsonl'), '');

const envBase: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome };
delete envBase.XDG_DATA_HOME;

// Bloco separado para o caso `${XDG_DATA_HOME}`: aqui D = <xdgTmp>/hexlog.
const xdgTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-guarda-bash-xdg-'));
const dadosDirXdg = path.join(xdgTmp, 'hexlog');
fs.mkdirSync(path.join(dadosDirXdg, 'p', 'r'), { recursive: true });
fs.writeFileSync(path.join(dadosDirXdg, 'p', 'r', 'eventos.jsonl'), '');
const envXdg: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome, XDG_DATA_HOME: xdgTmp };

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(xdgTmp, { recursive: true, force: true });
});

interface EntradaHook {
  command: string;
  cwd?: string;
}

function rodarHook(entrada: EntradaHook, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [caminhoDoHook], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: entrada.command },
      ...(entrada.cwd ? { cwd: entrada.cwd } : {}),
    }),
    env,
    cwd: raizDoRepo,
    encoding: 'utf8',
  });
}

interface CasoI4 {
  nome: string;
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  classe?: 'lacuna' | 'falso-positivo';
}

const casosNega: CasoI4[] = [
  { nome: 'caminho absoluto de D', command: `cat ${dadosDir}/x` },
  { nome: '~ expandido para D', command: 'cat ~/.local/share/hexlog/p/r/eventos.jsonl' },
  { nome: '$HOME expandido pelo shell-quote', command: 'cat $HOME/.local/share/hexlog/x' },
  {
    nome: 'aspas duplas vazias no meio do nome (hex""log)',
    command: 'cat ~/.local/share/hex""log/x',
  },
  {
    nome: 'substituição de comando: $(echo ~/...)',
    command: 'cat $(echo ~/.local/share/hexlog/x)',
  },
  { nome: '/./ no meio do caminho absoluto', command: `cat /./${dadosDir.slice(1)}/x` },
  {
    nome: 'relativo a D com cwd no pai de D',
    command: 'cat hexlog/p/r/eventos.jsonl',
    cwd: cwdPaiDeDados,
  },
  { nome: '--opt=<D>/x', command: `--opt=${dadosDir}/x` },
  { nome: 'glob hex*', command: 'cat ~/.local/share/hex*/p/r/eventos.jsonl' },
  { nome: 'glob hexl?g', command: 'cat ~/.local/share/hexl?g' },
  { nome: 'chave {hexlog,x}', command: 'cat ~/.local/share/{hexlog,x}' },
  { nome: 'classe de caracteres [h]exlog', command: 'cat ~/.local/share/[h]exlog' },
  { nome: 'glob * com cwd no pai de D', command: 'cat */p/r/eventos.jsonl', cwd: cwdPaiDeDados },
  { nome: 'glob no meio do caminho (~/.local/*/hexlog/x)', command: 'cat ~/.local/*/hexlog/x' },
  {
    nome: '** cujo prefixo literal é ancestral de D (R-6)',
    command: 'cat ~/.local/**/eventos.jsonl',
  },
  {
    nome: 'chave com barra dentro ({hexlog/p/r/eventos.jsonl,x})',
    command: 'cat ~/.local/share/{hexlog/p/r/eventos.jsonl,x}',
  },
  {
    nome: 'falso positivo aceito: ** cujo prefixo é ancestral de D',
    command: 'ls ~/**/*.md',
    classe: 'falso-positivo',
  },
];

const casoXdg: CasoI4 = {
  nome: '${XDG_DATA_HOME} expandido pelo shell-quote',
  command: 'cat ${XDG_DATA_HOME}/hexlog/x',
  env: envXdg,
};

const casosPermite: CasoI4[] = [
  { nome: 'ls no diretório pai de D', command: 'ls ~/.local/share' },
  { nome: 'ls com glob raso no pai de D', command: 'ls ~/.local/*' },
  { nome: 'find a partir de ~ sem citar D', command: "find ~ -name '*.jsonl'" },
  { nome: 'Read fora de D (~/.claude/projects)', command: 'cat ~/.claude/projects/x/y.jsonl' },
  { nome: 'cd para o repo e rodar testes', command: `cd ${raizDoRepo} && npm test` },
  {
    nome: '** dentro do repositório (não é ancestral de D)',
    command: `grep -rn x ${raizDoRepo}/**/*.ts`,
  },
  {
    nome: 'lacuna: cd + caminho relativo em comandos separados',
    command: 'cd ~/.local/share && cat hexlog/p/r/eventos.jsonl',
    classe: 'lacuna',
  },
  {
    nome: 'lacuna: grep -r no diretório pai de D',
    command: 'grep -r foo ~/.local/share/',
    classe: 'lacuna',
  },
  {
    nome: 'lacuna: variável atribuída no mesmo comando',
    command: 'd=~/.local/share; cat $d/hexlog/x',
    classe: 'lacuna',
  },
  {
    nome: "lacuna: ANSI-C quoting ($'...\\x6c...')",
    command: `cat $'${tmpHome}/.local/share/hex\\x6cog/x'`,
    classe: 'lacuna',
  },
  {
    nome: 'lacuna: alternância zsh ((hexlog|x))',
    command: 'cat ~/.local/share/(hexlog|x)/p/r/eventos.jsonl',
    classe: 'lacuna',
  },
];

describe('guarda-bash (I4): nega o acesso a D por Bash', () => {
  for (const caso of casosNega) {
    test(caso.nome, () => {
      const resultado = rodarHook(caso, caso.env ?? envBase);
      expect(resultado.status).toBe(2);
      expect(resultado.stderr).toContain('só é acessível pelas tools MCP do hexlog');
    });
  }

  test(casoXdg.nome, () => {
    const resultado = rodarHook(casoXdg, casoXdg.env!);
    expect(resultado.status).toBe(2);
    expect(resultado.stderr).toContain(dadosDirXdg);
  });
});

describe('guarda-bash (I4): permite o que não alcança D', () => {
  for (const caso of casosPermite) {
    test(caso.nome, () => {
      const resultado = rodarHook(caso, caso.env ?? envBase);
      expect(resultado.status).toBe(0);
      expect(resultado.stderr).toBe('');
    });
  }
});

describe('guarda-bash (I7): entrada inválida ou exceção interna falha aberto', () => {
  test('stdin vazio → exit 0 sem saída', () => {
    const resultado = spawnSync(process.execPath, [caminhoDoHook], {
      input: '',
      env: envBase,
      encoding: 'utf8',
    });
    expect(resultado.status).toBe(0);
    expect(resultado.stdout).toBe('');
    expect(resultado.stderr).toBe('');
  });

  test('JSON inválido → exit 0 sem saída', () => {
    const resultado = spawnSync(process.execPath, [caminhoDoHook], {
      input: '{isso não é json',
      env: envBase,
      encoding: 'utf8',
    });
    expect(resultado.status).toBe(0);
    expect(resultado.stderr).toBe('');
  });

  test('tool_name diferente de Bash → exit 0 sem saída', () => {
    const resultado = spawnSync(process.execPath, [caminhoDoHook], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: dadosDir } }),
      env: envBase,
      encoding: 'utf8',
    });
    expect(resultado.status).toBe(0);
    expect(resultado.stderr).toBe('');
  });

  test('tool_input sem command → exit 0 sem saída', () => {
    const resultado = spawnSync(process.execPath, [caminhoDoHook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
      env: envBase,
      encoding: 'utf8',
    });
    expect(resultado.status).toBe(0);
    expect(resultado.stderr).toBe('');
  });

  test('shell-quote.parse lançando: decide só pela checagem literal (contém D → nega)', () => {
    const resultado = rodarHook({ command: `cat \${} ${dadosDir}/x` }, envBase);
    expect(resultado.status).toBe(2);
    expect(resultado.stderr).toContain('só é acessível pelas tools MCP do hexlog');
  });

  test('shell-quote.parse lançando: decide só pela checagem literal (sem D → permite)', () => {
    const resultado = rodarHook({ command: 'cat ${} /tmp/algo-sem-relacao' }, envBase);
    expect(resultado.status).toBe(0);
    expect(resultado.stderr).toBe('');
  });
});

describe('B1(b): hook empacotado pelo esbuild', () => {
  const outdirBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-guarda-bash-bundle-'));
  const bundle = path.join(outdirBundle, 'guarda-bash.mjs');

  const build = spawnSync(
    process.execPath,
    [path.join(raizDoRepo, 'test/fixtures/build-hook.ts'), outdirBundle],
    { encoding: 'utf8', cwd: raizDoRepo },
  );
  if (build.status !== 0) {
    throw new Error(`build do hook falhou: ${build.stderr}`);
  }

  afterAll(() => {
    fs.rmSync(outdirBundle, { recursive: true, force: true });
  });

  test('nega cat <D>/x (exit 2) e permite true (exit 0)', () => {
    const nega = spawnSync(process.execPath, [bundle], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cat ${dadosDir}/x` } }),
      env: envBase,
      encoding: 'utf8',
    });
    expect(nega.status).toBe(2);
    expect(nega.stderr).toContain('só é acessível pelas tools MCP do hexlog');

    const permite = spawnSync(process.execPath, [bundle], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } }),
      env: envBase,
      encoding: 'utf8',
    });
    expect(permite.status).toBe(0);
    expect(permite.stderr).toBe('');
  });

  test('o bundle não contém o shim "Dynamic require of"', () => {
    const bytes = fs.readFileSync(bundle);
    expect(bytes.includes('Dynamic require of')).toBe(false);
  });
});

describe('latência (informativo, sem asserção rígida)', () => {
  test('média de 10 execuções do hook .ts', () => {
    const tempos: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const inicio = performance.now();
      rodarHook({ command: 'true' }, envBase);
      tempos.push(performance.now() - inicio);
    }
    const media = tempos.reduce((soma, tempo) => soma + tempo, 0) / tempos.length;
    console.log(`hook/bash-guard.ts: média de 10 execuções = ${media.toFixed(1)} ms`);
    expect(tempos).toHaveLength(10);
  });
});
