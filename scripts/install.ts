// Instalador versionado do hexlog. Entrypoint real: liga `build`
// (esbuild), `Client`/`StdioClientTransport` (devDependency) e `claude mcp` às
// funções puras de `src/installation.ts` e `src/guard.ts`. Os testes
// (`test/guard.spec.ts`, describes B2/B3) chamam `installArtifact`/
// `verifyInstallation` direto com `HOME` temporário, nunca o `HOME` real.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isUndefined } from 'es-toolkit';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { build, repoRoot } from './build.ts';
import { detectLegacy } from '../src/adapters/fs/data-format.ts';
import { readIfPresent } from '../src/adapters/fs/io.ts';
import { archiveLegacy, inspectLegacy } from '../src/archive.ts';
import { dataDir } from '../src/directory.ts';
import { expectedRules, libDirOf, mcpRegistered, runRealHook } from '../src/guard.ts';
import {
  installArtifact,
  registerGuard,
  writeSkillFolder,
  verifyInstallation,
  type Bundles,
} from '../src/installation.ts';

function readPackageJsonVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/** Nome de cada pasta em `skills/` (uma por skill instalável, `hexlog` inclusa). */
function skillNames(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function currentCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function isWorkingTreeDirty(): boolean {
  try {
    return (
      execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
        .length > 0
    );
  } catch {
    return false;
  }
}

async function buildBundles(): Promise<Bundles> {
  const result = await build({ write: false });
  const file = (name: string): Buffer => {
    const output = result.outputFiles?.find((f) => path.basename(f.path) === `${name}.mjs`);
    if (!output) throw new Error(`build did not produce ${name}.mjs`);
    return Buffer.from(output.contents);
  };
  return { server: file('server'), hook: file('bash-guard') };
}

/** Sobe o servidor preparado num `HOME`/`XDG_DATA_HOME` descartáveis e conta as tools anunciadas. */
async function countTools(serverFile: string): Promise<number> {
  const disposableHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-verify-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverFile],
    env: { HOME: disposableHome, XDG_DATA_HOME: path.join(disposableHome, 'data') },
  });
  const client = new Client({ name: 'hexlog-installer', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.length;
  } finally {
    await client.close();
    fs.rmSync(disposableHome, { recursive: true, force: true });
  }
}

/** `claude mcp remove`+`add`; substituível por `HEXLOG_REGISTER_MCP=<script>` nos testes (sem depender do binário `claude`). */
function registerMcp(execPath: string, serverFile: string): void {
  const testScript = process.env.HEXLOG_REGISTER_MCP;
  if (testScript) {
    execFileSync(process.execPath, [testScript, execPath, serverFile], {
      stdio: 'inherit',
    });
    return;
  }
  try {
    execFileSync('claude', ['mcp', 'remove', 'hexlog', '-s', 'user'], { stdio: 'ignore' });
  } catch {
    // Sem entrada prévia: nada a remover, segue direto pro add.
  }
  execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'hexlog', '--', execPath, serverFile], {
    stdio: 'inherit',
  });
}

async function install(D: string): Promise<void> {
  const version = readPackageJsonVersion();
  const names = skillNames();
  const bundles = await buildBundles();
  const home = os.homedir();

  const result = await installArtifact({
    home,
    version,
    bundles,
    commit: currentCommit(),
    dirty: isWorkingTreeDirty(),
    clock: () => new Date(),
    runHook: (hookFile, stdin) => runRealHook(process.execPath, hookFile, stdin),
    verifyServer: countTools,
  });

  const expected = expectedRules(D, home, process.execPath, version);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  // As skills vêm antes do guard: se a troca falhar, o `settings.json` não chega a ser gravado.
  for (const name of names) {
    writeSkillFolder(home, name, path.join(repoRoot, 'skills', name));
  }
  const { changed, removed } = registerGuard({ settingsPath, expected });

  const claudeJsonText = readIfPresent(path.join(home, '.claude.json')) ?? null;
  if (!mcpRegistered(claudeJsonText, expected)) {
    registerMcp(process.execPath, expected.serverFile);
  }

  const summary =
    result.action === 'none' ? 'already installed and intact; nothing to do' : result.action;
  console.log(`hexlog ${version}: ${summary}`);
  console.log(`  server sha256: ${result.manifest.sha256.server}`);
  console.log(`  hook sha256: ${result.manifest.sha256.hook}`);
  console.log(`  settings.json: ${changed ? 'updated' : 'already correct'}`);
  for (const rule of removed) console.log(`  removed deny rule: ${rule}`);
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
}

async function check(D: string): Promise<void> {
  const home = os.homedir();
  const version = readPackageJsonVersion();
  const settingsText = readIfPresent(path.join(home, '.claude', 'settings.json')) ?? null;
  const claudeJsonText = readIfPresent(path.join(home, '.claude.json')) ?? null;
  const currentBundles = await buildBundles();

  const result = verifyInstallation({
    home,
    version,
    execPath: process.execPath,
    D,
    skillNames: skillNames(),
    currentBundles,
    settingsText,
    claudeJsonText,
    runHook: runRealHook,
    currentHead: currentCommit(),
  });

  for (const item of result.missing) console.log(`missing: ${item}`);
  for (const warning of result.warnings) console.log(`warning: ${warning}`);
  if (result.missing.length === 0 && result.warnings.length === 0) console.log('ok');
  process.exitCode = result.exit;
}

const KNOWN_FLAGS = new Set(['--check', '--archive-0x']);

type Mode = 'check' | 'list' | 'archive' | 'install';

/**
 * `--check` nunca arquiva; dado 0.x sem `--archive-0x` só lista; sem dado 0.x instala como sempre.
 * `hasLegacy` é função para `--check` nem tocar em `<D>` (um `<D>` ilegível faria `detectLegacy` lançar).
 */
function pickMode(args: string[], hasLegacy: () => boolean): Mode {
  if (args.includes('--check')) return 'check';
  if (!hasLegacy()) return 'install';
  return args.includes('--archive-0x') ? 'archive' : 'list';
}

function listLegacy(D: string): void {
  const { files, dirs } = inspectLegacy(D);
  console.log(`0.x data found in ${D}; rerun with --archive-0x to archive it into ${D}/archive/`);
  for (const dir of dirs) console.log(`  dir: ${dir}`);
  for (const file of files)
    console.log(`  file: ${file.path} (${file.size} bytes) sha256 ${file.sha256}`);
  process.exitCode = 2;
}

/** `--archive-0x`: arquiva o dado 0.x e imprime o que fez; `ArchiveError` sobe para o `catch` de `main`. */
function archiveAndReport(D: string): void {
  const result = archiveLegacy(D, { libDir: libDirOf(os.homedir()), now: () => new Date() });
  if (!result.archived) return;
  console.log(
    isUndefined(result.tarPath)
      ? `removed ${result.dirs} empty 0.x directories`
      : `archived ${result.files} file(s) of 0.x data into ${result.tarPath}`,
  );
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const unknown = args.find((arg) => !KNOWN_FLAGS.has(arg));
    if (!isUndefined(unknown)) {
      throw new Error(`unknown argument: ${unknown} (accepted: --check, --archive-0x)`);
    }
    const D = dataDir(process.env);
    const mode = pickMode(args, () => detectLegacy(D).length > 0);
    if (mode === 'check') {
      await check(D);
    } else if (mode === 'list') {
      listLegacy(D);
    } else {
      if (mode === 'archive') archiveAndReport(D);
      await install(D);
    }
  } catch (error) {
    // `ArchiveError` também cai aqui: mensagem em stderr, exit 1 e nenhuma instalação.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- engine >=24.18.1 já suporta import.meta.main, plugin n ainda marca como experimental
if (import.meta.main) {
  await main();
}
