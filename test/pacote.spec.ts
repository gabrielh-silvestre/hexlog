import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VERSAO } from '../src/versao.ts';

const raizDoRepo = path.resolve(__dirname, '..');
const DIRETORIOS_IGNORADOS = new Set(['node_modules', 'dist', '.omc', '.git', 'coverage']);

/** Lista recursivamente os arquivos com a extensão dada, pulando diretórios de build/dependências. */
function listarArquivosRecursivo(dir: string, extensao = '.ts'): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      return DIRETORIOS_IGNORADOS.has(entrada.name) ? [] : listarArquivosRecursivo(caminho, extensao);
    }
    return entrada.name.endsWith(extensao) ? [caminho] : [];
  });
}

/** Lista recursivamente todos os diretórios do repo, pulando node_modules/.git. */
function listarDiretorios(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    if (!entrada.isDirectory() || entrada.name === 'node_modules' || entrada.name === '.git') return [];
    const caminho = path.join(dir, entrada.name);
    return [caminho, ...listarDiretorios(caminho)];
  });
}

/** Extrai os especificadores de import/require de um arquivo TS (estático, via regex — sem parser de AST). */
function extrairEspecificadores(conteudo: string): string[] {
  const regexes = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return regexes.flatMap((regex) => [...conteudo.matchAll(regex)].map((m) => m[1]));
}

/** Um especificador relativo (`.`) ou absoluto (`/`) que resolve para fora da raiz do repo. */
function saiDoRepo(especificador: string, arquivo: string): boolean {
  if (!especificador.startsWith('.') && !especificador.startsWith('/')) return false;
  const alvo = path.resolve(path.dirname(arquivo), especificador);
  const relativo = path.relative(raizDoRepo, alvo);
  return relativo.startsWith('..') || path.isAbsolute(relativo);
}

const pkg = JSON.parse(fs.readFileSync(path.join(raizDoRepo, 'package.json'), 'utf8'));

describe('N7', () => {
  test('package.json não depende de xstate, hexnucleus, core.poc-motor-log nem uuid', () => {
    const todasAsDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const proibido of ['xstate', 'hexnucleus', 'core.poc-motor-log', 'uuid']) {
      expect(todasAsDeps).not.toHaveProperty(proibido);
    }
  });

  test('nenhum import relativo/absoluto em src/, hook/, scripts/ ou test/ sai do repo', () => {
    const arquivos = ['src', 'hook', 'scripts', 'test'].flatMap((dir) =>
      listarArquivosRecursivo(path.join(raizDoRepo, dir)),
    );
    const violacoes = arquivos.flatMap((arquivo) =>
      extrairEspecificadores(fs.readFileSync(arquivo, 'utf8'))
        .filter((especificador) => saiDoRepo(especificador, arquivo))
        .map((especificador) => `${path.relative(raizDoRepo, arquivo)}: ${especificador}`),
    );
    expect(violacoes).toEqual([]);
  });
});

describe('S6', () => {
  test('zod está fixado em 4.6.5', () => {
    expect(pkg.dependencies.zod).toBe('4.6.5');
  });
});

describe('N11', () => {
  // Manifesto literal de §2.2 — versões exatas (npm install --save-exact).
  const DEPENDENCIAS_ESPERADAS = {
    '@modelcontextprotocol/server': '2.0.0',
    zod: '4.6.5',
    ajv: '8.20.0',
    'ajv-formats': '3.0.1',
    canonicalize: '5.0.0',
    'shell-quote': '1.10.0',
    'jsonc-parser': '3.3.1',
    'es-toolkit': '1.52.0',
    minisearch: '7.2.0',
  };
  const DEV_DEPENDENCIAS_ESPERADAS = {
    '@modelcontextprotocol/client': '2.0.0',
    jest: '30.5.1',
    '@jest/globals': '30.5.1',
    'ts-jest': '29.4.12',
    typescript: '5.9.2',
    '@types/node': '24.8.1',
    '@types/shell-quote': '1.7.5',
    'fast-check': '4.10.1',
    esbuild: '0.28.2',
  };

  test('dependencies bate exatamente com o manifesto de §2.2 (sem ^/~/faixas)', () => {
    expect(pkg.dependencies).toEqual(DEPENDENCIAS_ESPERADAS);
  });

  test('devDependencies bate exatamente com o manifesto de §2.2 (sem ^/~/faixas)', () => {
    expect(pkg.devDependencies).toEqual(DEV_DEPENDENCIAS_ESPERADAS);
  });

  test('engines.node é >=24.18.1', () => {
    expect(pkg.engines).toEqual({ node: '>=24.18.1' });
  });

  test('VERSAO de src/versao.ts bate com package.json.version', () => {
    expect(VERSAO).toBe(pkg.version);
  });

  test('.gitignore contém a linha dist/', () => {
    const gitignore = fs.readFileSync(path.join(raizDoRepo, '.gitignore'), 'utf8');
    expect(gitignore.split('\n')).toContain('dist/');
  });
});

describe('M5', () => {
  test('package.json não declara bin', () => {
    expect(pkg.bin).toBeUndefined();
  });

  test('nenhum arquivo em src/ contém createServer nem listen(', () => {
    const violacoes = listarArquivosRecursivo(path.join(raizDoRepo, 'src')).filter((arquivo) =>
      /createServer|listen\(/.test(fs.readFileSync(arquivo, 'utf8')),
    );
    expect(violacoes).toEqual([]);
  });

  test('não existe diretório cli no repo (fora de node_modules)', () => {
    const temDiretorioCli = listarDiretorios(raizDoRepo).some((dir) => path.basename(dir) === 'cli');
    expect(temDiretorioCli).toBe(false);
  });
});

describe('M6 (estático)', () => {
  test('nenhum arquivo .ts em src/ usa console de depuração ou process.stdout.write', () => {
    const REGEX_SAIDA_PROIBIDA = /console\.(log|info|debug|dir|table|trace)|process\.stdout\.write/;
    const violacoes = listarArquivosRecursivo(path.join(raizDoRepo, 'src')).filter((arquivo) =>
      REGEX_SAIDA_PROIBIDA.test(fs.readFileSync(arquivo, 'utf8')),
    );
    expect(violacoes).toEqual([]);
  });
});

describe('I1 (parcial)', () => {
  test('src/diretorio.ts só importa node:* e es-toolkit, nunca zod/canonicalize/minisearch', () => {
    const conteudo = fs.readFileSync(path.join(raizDoRepo, 'src/diretorio.ts'), 'utf8');
    const violacoes = extrairEspecificadores(conteudo).filter(
      (especificador) =>
        !especificador.startsWith('node:') && especificador !== 'es-toolkit' && !especificador.startsWith('es-toolkit/'),
    );
    expect(violacoes).toEqual([]);
  });
});
