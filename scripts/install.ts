// Instalador versionado do hexlog (§4.14). Entrypoint real: liga `build`
// (esbuild), `Client`/`StdioClientTransport` (devDependency) e `claude mcp` às
// funções puras de `src/installation.ts` e `src/guard.ts`. Os testes
// (`test/guard.spec.ts`, describes B2/B3) chamam `installArtifact`/
// `verifyInstallation` direto com `HOME` temporário, nunca o `HOME` real.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { build } from './build.ts';
import { dataDir } from '../src/directory.ts';
import { expectedRules, runRealHook } from '../src/guard.ts';
import {
  installArtifact,
  registerGuard,
  writeSkill,
  needsMcpRegistration,
  verifyInstallation,
  type Bundles,
} from '../src/installation.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readPackageJsonVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
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

async function install(): Promise<void> {
  const version = readPackageJsonVersion();
  const skillText = fs.readFileSync(path.join(repoRoot, 'skills', 'hexlog', 'SKILL.md'), 'utf8');
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
    log: (message) => console.log(message),
  });

  const D = dataDir(process.env);
  const expected = expectedRules(D, home, process.execPath, version);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const { changed } = registerGuard({ settingsPath, expected });

  writeSkill(home, skillText);

  const claudeJsonText = readIfExists(path.join(home, '.claude.json'));
  if (needsMcpRegistration(claudeJsonText, expected)) {
    registerMcp(process.execPath, expected.serverFile);
  }

  console.log(`hexlog ${version}: ${result.action}`);
  console.log(`  server sha256: ${result.manifest.sha256.server}`);
  console.log(`  hook sha256: ${result.manifest.sha256.hook}`);
  console.log(`  settings.json: ${changed ? 'updated' : 'already correct'}`);
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
}

async function check(): Promise<void> {
  const home = os.homedir();
  const version = readPackageJsonVersion();
  const D = dataDir(process.env);
  const settingsText = readIfExists(path.join(home, '.claude', 'settings.json'));
  const claudeJsonText = readIfExists(path.join(home, '.claude.json'));
  const currentBundles = await buildBundles();

  const result = verifyInstallation({
    home,
    version,
    execPath: process.execPath,
    D,
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

async function main(): Promise<void> {
  try {
    if (process.argv.includes('--check')) {
      await check();
    } else {
      await install();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
