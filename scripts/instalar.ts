// Instalador versionado do hexlog (§4.14). Entrypoint real: liga `construir`
// (esbuild), `Client`/`StdioClientTransport` (devDependency) e `claude mcp` às
// funções puras de `src/instalacao.ts` e `src/guarda.ts`. Os testes
// (`test/guarda.spec.ts`, describes B2/B3) chamam `instalarArtefato`/
// `verificarInstalacao` direto com `HOME` temporário, nunca o `HOME` real.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { construir } from './build.ts';
import { dirDados } from '../src/diretorio.ts';
import { regrasEsperadas, executarHookReal } from '../src/guarda.ts';
import {
  instalarArtefato,
  registrarGuard,
  precisaRegistrarMcp,
  verificarInstalacao,
  type Bundles,
} from '../src/instalacao.ts';

const raizDoRepo = path.resolve(import.meta.dirname, '..');

function lerVersaoDoPackageJson(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(raizDoRepo, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

function lerSeExistir(arquivo: string): string | null {
  return fs.existsSync(arquivo) ? fs.readFileSync(arquivo, 'utf8') : null;
}

function commitAtual(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: raizDoRepo, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function workingTreeSuja(): boolean {
  try {
    return (
      execFileSync('git', ['status', '--porcelain'], { cwd: raizDoRepo, encoding: 'utf8' }).trim()
        .length > 0
    );
  } catch {
    return false;
  }
}

async function construirBundles(): Promise<Bundles> {
  const resultado = await construir({ write: false });
  const arquivo = (nome: string): Buffer => {
    const saida = resultado.outputFiles?.find((f) => path.basename(f.path) === `${nome}.mjs`);
    if (!saida) throw new Error(`build não produziu ${nome}.mjs`);
    return Buffer.from(saida.contents);
  };
  return { servidor: arquivo('servidor'), hook: arquivo('guarda-bash') };
}

/** Sobe o servidor preparado num `HOME`/`XDG_DATA_HOME` descartáveis e conta as tools anunciadas. */
async function contarTools(arquivoServidor: string): Promise<number> {
  const homeDescartavel = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-verifica-'));
  const transporte = new StdioClientTransport({
    command: process.execPath,
    args: [arquivoServidor],
    env: { HOME: homeDescartavel, XDG_DATA_HOME: path.join(homeDescartavel, 'dados') },
  });
  const cliente = new Client({ name: 'hexlog-instalador', version: '0.0.0' });
  try {
    await cliente.connect(transporte);
    const { tools } = await cliente.listTools();
    return tools.length;
  } finally {
    await cliente.close();
    fs.rmSync(homeDescartavel, { recursive: true, force: true });
  }
}

/** `claude mcp remove`+`add`; substituível por `HEXLOG_REGISTRAR_MCP=<script>` nos testes (sem depender do binário `claude`). */
function registrarMcp(execPath: string, arquivoServidor: string): void {
  const scriptDeTeste = process.env.HEXLOG_REGISTRAR_MCP;
  if (scriptDeTeste) {
    execFileSync(process.execPath, [scriptDeTeste, execPath, arquivoServidor], {
      stdio: 'inherit',
    });
    return;
  }
  try {
    execFileSync('claude', ['mcp', 'remove', 'hexlog', '-s', 'user'], { stdio: 'ignore' });
  } catch {
    // Sem entrada prévia: nada a remover, segue direto pro add.
  }
  execFileSync(
    'claude',
    ['mcp', 'add', '--scope', 'user', 'hexlog', '--', execPath, arquivoServidor],
    {
      stdio: 'inherit',
    },
  );
}

async function instalar(): Promise<void> {
  const versao = lerVersaoDoPackageJson();
  const bundles = await construirBundles();
  const home = os.homedir();

  const resultado = await instalarArtefato({
    home,
    versao,
    bundles,
    commit: commitAtual(),
    sujo: workingTreeSuja(),
    agora: () => new Date(),
    executarHook: (arquivoHook, stdin) => executarHookReal(process.execPath, arquivoHook, stdin),
    verificarServidor: contarTools,
    log: (mensagem) => console.log(mensagem),
  });

  const D = dirDados(process.env);
  const esperado = regrasEsperadas(D, home, process.execPath, versao);
  const caminhoSettings = path.join(home, '.claude', 'settings.json');
  const { mudou } = registrarGuard({ caminhoSettings, esperado });

  const textoClaudeJson = lerSeExistir(path.join(home, '.claude.json'));
  if (precisaRegistrarMcp(textoClaudeJson, esperado)) {
    registrarMcp(process.execPath, esperado.servidorArquivo);
  }

  console.log(`hexlog ${versao}: ${resultado.acao}`);
  console.log(`  servidor sha256: ${resultado.manifesto.sha256.servidor}`);
  console.log(`  hook sha256: ${resultado.manifesto.sha256.hook}`);
  console.log(`  settings.json: ${mudou ? 'atualizado' : 'já estava correto'}`);
  for (const aviso of resultado.avisos) console.log(`  aviso: ${aviso}`);
}

async function checar(): Promise<void> {
  const home = os.homedir();
  const versao = lerVersaoDoPackageJson();
  const D = dirDados(process.env);
  const textoSettings = lerSeExistir(path.join(home, '.claude', 'settings.json'));
  const textoClaudeJson = lerSeExistir(path.join(home, '.claude.json'));
  const bundlesAtuais = await construirBundles();

  const resultado = verificarInstalacao({
    home,
    versao,
    execPath: process.execPath,
    D,
    bundlesAtuais,
    textoSettings,
    textoClaudeJson,
    executarHook: executarHookReal,
    headAtual: commitAtual(),
  });

  for (const item of resultado.faltando) console.log(`faltando: ${item}`);
  for (const aviso of resultado.avisos) console.log(`aviso: ${aviso}`);
  if (resultado.faltando.length === 0 && resultado.avisos.length === 0) console.log('ok');
  process.exitCode = resultado.exit;
}

async function main(): Promise<void> {
  try {
    if (process.argv.includes('--check')) {
      await checar();
    } else {
      await instalar();
    }
  } catch (erro) {
    process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
