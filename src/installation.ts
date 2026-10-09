// Instalação versionada do artefato: copia os bundles para
// `~/.local/lib/hexlog/<versão>/`, registra o guard em `settings.json` e decide
// se o MCP precisa ser (re)registrado. Puro e testável: toda execução externa
// (hook, servidor, relógio) é injetada — nada aqui chama `claude` nem builda.
// Não é importado pelo servidor nem pelo hook, só por `scripts/install.ts`.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
// import default (não `* as fs`): sob esModuleInterop, `* as` copia o módulo com getters
// não configuráveis, o que impede `jest.spyOn(fs, 'renameSync')` de interceptar esta chamada
// a partir do teste (mesmo motivo documentado no comentário do `import fs` de src/adapters/fs/process-store.ts).
import fs, { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { isError, isNil } from 'es-toolkit';
import {
  expectedRules,
  libDirOf,
  applyGuard,
  verifyGuard,
  findHookEntry,
  skillFileOf,
  hookProbes,
  type ExpectedRules,
  type MissingItem,
} from './guard.ts';
import { sha256hex } from './domain/chain.ts';
import { HexlogError } from './errors.ts';
import { dataDir } from './directory.ts';
import { errnoCode, writeFileAtomic } from './adapters/fs/atomic.ts';
import { orIfMissing, readIfPresent } from './adapters/fs/io.ts';

export type Bundles = { server: Buffer; hook: Buffer };
/** sha256 dos 2 artefatos (server/hook) de um build ou de uma instalação. */
export type BuildShas = { server: string; hook: string };
export type InstallManifest = {
  version: string;
  sha256: BuildShas;
  builtAt: string;
  commit: string | null;
  dirty: boolean;
};

// Vive aqui e não em `scripts/build.ts`: aquele módulo usa `import.meta.dirname`/`import.meta.main`,
// incompatíveis com o transform CJS do ts-jest, e este arquivo é `import`-ado direto pelos testes.
function hasDynamicRequire(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).includes('Dynamic require of');
}

// As 12 tools registradas em src/mcp/tools/.
export const TOOLS_COUNT = 12;

export function versionDirOf(home: string, version: string): string {
  return path.join(libDirOf(home), version);
}

export function readManifest(versionDir: string): InstallManifest | null {
  try {
    const text = readIfPresent(path.join(versionDir, 'manifest.json'));
    return isNil(text) ? null : (JSON.parse(text) as InstallManifest);
  } catch {
    return null;
  }
}

type Shas = { server: string | null; hook: string | null };

function shasOf(bundles: Bundles): BuildShas {
  return { server: sha256hex(bundles.server), hook: sha256hex(bundles.hook) };
}

function installedShas(versionDir: string): Shas {
  const shaOfFile = (name: string): string | null => {
    const file = path.join(versionDir, name);
    return orIfMissing(() => sha256hex(readFileSync(file)), null);
  };
  return {
    server: shaOfFile('server.mjs'),
    hook: shaOfFile('bash-guard.mjs'),
  };
}

/** Os 2 artefatos (server/hook) batem entre duas leituras de sha256. */
function shasEqual(a: Shas, b: Shas): boolean {
  return a.server === b.server && a.hook === b.hook;
}

/** `ENOENT` cobre a reinstalação: o primeiro `renameSync(versionDir, old)` acha `versionDir` já
 * movido por outro instalador que chegou primeiro — mesma resolução de `ENOTEMPTY`/`EEXIST`. */
function isDirectoryBusyError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT';
}

/** Verifica o artefato preparado em `tmp` antes de trocar: qualquer falha aborta sem tocar em nada. */
async function verifyPreparedArtifact(args: {
  tmp: string;
  bundles: Bundles;
  runHook: (hookFile: string, stdin: string) => { status: number | null };
  verifyServer: (serverFile: string) => Promise<number>;
}): Promise<void> {
  const { tmp, bundles, runHook, verifyServer } = args;
  if (hasDynamicRequire(bundles.server) || hasDynamicRequire(bundles.hook)) {
    throw new HexlogError('INTERNAL', 'bundle contains "Dynamic require of"; installation aborted');
  }

  // Mesma checagem funcional de `verifyGuard` (nega o diretório de dados, permite o resto),
  // mas contra o hook recém-preparado em `tmp`, antes de virar o hook instalado de verdade.
  const hookFile = path.join(tmp, 'bash-guard.mjs');
  const probes = hookProbes(dataDir(process.env));
  if (runHook(hookFile, probes.deny).status !== 2) {
    throw new HexlogError('INTERNAL', 'prepared hook does not deny access to the data directory');
  }
  if (runHook(hookFile, probes.allow).status !== 0) {
    throw new HexlogError('INTERNAL', 'prepared hook does not allow harmless commands');
  }

  let toolsCount: number;
  try {
    toolsCount = await verifyServer(path.join(tmp, 'server.mjs'));
  } catch (error) {
    const message = isError(error) ? error.message : String(error);
    throw new HexlogError('INTERNAL', `prepared server failed to start: ${message}`);
  }
  if (toolsCount !== TOOLS_COUNT) {
    throw new HexlogError(
      'INTERNAL',
      `prepared server listed ${toolsCount} tools, expected ${TOOLS_COUNT}`,
    );
  }
}

/** Reage a um `renameSync` que achou `versionDir` ocupado: outro instalador pode ter terminado primeiro. */
function resolveConcurrency(
  error: unknown,
  tmp: string,
  versionDir: string,
  shaBuild: BuildShas,
  version: string,
): { action: 'none'; extraWarning: null } {
  if (!isDirectoryBusyError(error)) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  const installedNow = installedShas(versionDir);
  rmSync(tmp, { recursive: true, force: true });
  if (shasEqual(installedNow, shaBuild)) {
    return { action: 'none', extraWarning: null };
  }
  throw new HexlogError(
    'INTERNAL',
    `another installation swapped ${version} at the same time; run the installer again`,
  );
}

/** Troca atômica de `tmp` para `dst`: se `dst` já existe, move pra `old` antes e só remove
 * `old` depois do rename de `tmp` ter sucesso; se esse segundo rename falhar, desfaz o
 * primeiro (`old` -> `dst`) antes de relançar, pra nunca deixar `dst` ausente no meio do caminho. */
function swapDirectory(tmp: string, dst: string, old: string): void {
  const existedBefore = existsSync(dst);
  try {
    if (existedBefore) fs.renameSync(dst, old);
    fs.renameSync(tmp, dst);
    if (existedBefore) rmSync(old, { recursive: true, force: true });
  } catch (error) {
    if (existedBefore && existsSync(old) && !existsSync(dst)) fs.renameSync(old, dst);
    throw error;
  }
}

/** Troca atômica de `tmp` para `versionDir`, cobrindo instalação nova, reinstalação e concorrência. */
function swapArtifact(args: {
  versionDir: string;
  tmp: string;
  existedBefore: boolean;
  shaBuild: BuildShas;
  modificationDetected: boolean;
  version: string;
}): { action: 'installed' | 'reinstalled' | 'repaired' | 'none'; extraWarning: string | null } {
  const { versionDir, tmp, existedBefore, shaBuild, modificationDetected, version } = args;

  if (!existedBefore) {
    try {
      fs.renameSync(tmp, versionDir);
      return { action: 'installed', extraWarning: null };
    } catch (error) {
      return resolveConcurrency(error, tmp, versionDir, shaBuild, version);
    }
  }

  // UUID, não relógio: dois instaladores no mesmo ms dividiriam o backup e um desfaria a troca do outro.
  const old = path.join(path.dirname(versionDir), `.${version}.old-${randomUUID()}`);
  try {
    swapDirectory(tmp, versionDir, old);
  } catch (error) {
    return resolveConcurrency(error, tmp, versionDir, shaBuild, version);
  }
  if (modificationDetected) return { action: 'repaired', extraWarning: null };
  return {
    action: 'reinstalled',
    extraWarning: `version ${version} reinstalled with different content; consider bumping the version`,
  };
}

/** Instala os bundles preparados como a versão ativa, idempotente pelos bytes instalados. */
export async function installArtifact(args: {
  home: string;
  version: string;
  bundles: Bundles;
  commit: string | null;
  dirty: boolean;
  clock: () => Date;
  runHook: (hookFile: string, stdin: string) => { status: number | null };
  verifyServer: (serverFile: string) => Promise<number>;
}): Promise<{
  action: 'none' | 'installed' | 'reinstalled' | 'repaired';
  versionDir: string;
  manifest: InstallManifest;
  warnings: string[];
}> {
  const { home, version, bundles, commit, dirty, clock, runHook, verifyServer } = args;
  const versionDir = versionDirOf(home, version);
  const shaBuild = shasOf(bundles);
  const manifest: InstallManifest = {
    version,
    sha256: shaBuild,
    builtAt: clock().toISOString(),
    commit,
    dirty,
  };
  const previousManifest = readManifest(versionDir);
  const installed = installedShas(versionDir);
  const existedBefore = existsSync(versionDir);

  if (shasEqual(installed, shaBuild)) {
    return {
      action: 'none',
      versionDir,
      manifest: previousManifest ?? manifest,
      warnings: [],
    };
  }

  // Divergem do build; se também divergem do próprio manifesto, o artefato instalado foi
  // alterado por fora (não é uma reinstalação normal com bundles novos) — repara e avisa.
  const modificationDetected =
    !isNil(previousManifest) && !shasEqual(installed, previousManifest.sha256);
  const warnings: string[] = [];
  if (modificationDetected) {
    warnings.push('installed artifact modified; repairing');
  }

  const tmp = path.join(path.dirname(versionDir), `.${version}.tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    writeFileSync(path.join(tmp, 'server.mjs'), bundles.server, { mode: 0o644 });
    writeFileSync(path.join(tmp, 'bash-guard.mjs'), bundles.hook, { mode: 0o644 });
    writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o644,
    });
    await verifyPreparedArtifact({ tmp, bundles, runHook, verifyServer });
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }

  const { action, extraWarning } = swapArtifact({
    versionDir,
    tmp,
    existedBefore,
    shaBuild,
    modificationDetected,
    version,
  });
  if (!isNil(extraWarning)) warnings.push(extraWarning);

  const finalManifest = action === 'none' ? (readManifest(versionDir) ?? manifest) : manifest;
  return { action, versionDir, manifest: finalManifest, warnings };
}

/**
 * Aplica o guard em `settings.json` (backup + troca atômica), só se algo mudou. `removed` lista as
 * regras de deny de um `<D>` antigo que o guard tirou, para o instalador não removê-las em silêncio.
 * O backup guarda o estado de antes da primeira instalação e nunca é sobrescrito (reinstalar sobre
 * um `settings.json` já alterado não perde o último estado bom); para renová-lo, apague-o. Se
 * `settingsPath` é um symlink, grava no destino e mantém o link e o modo do arquivo.
 */
export function registerGuard(args: { settingsPath: string; expected: ExpectedRules }): {
  changed: boolean;
  removed: string[];
} {
  const { settingsPath, expected } = args;
  if (!existsSync(settingsPath)) {
    throw new HexlogError('INTERNAL', 'install the harness before installing hexlog');
  }
  const oldText = readFileSync(settingsPath, 'utf8');
  const { text: newText, removed } = applyGuard(oldText, expected, existsSync);
  if (newText === oldText) return { changed: false, removed };
  const parseErrors: ParseError[] = [];
  parseJsonc(newText, parseErrors);
  if (parseErrors.length > 0) {
    throw new HexlogError('INTERNAL', 'refusing to write invalid settings.json');
  }

  try {
    writeFileAtomic(`${settingsPath}.bak-hexlog`, oldText, { exclusive: true });
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
  }
  // `rename` sobre o próprio symlink o trocaria por arquivo regular; o destino real preserva o link.
  const target = fs.realpathSync(settingsPath);
  const { mode } = fs.statSync(target);
  writeFileAtomic(target, newText);
  // `writeFileAtomic` cria o arquivo em 0600; devolve o modo que o usuário tinha escolhido.
  fs.chmodSync(target, mode & 0o7777);
  return { changed: true, removed };
}

/** `name` vira um segmento de path (`<home>/.claude/skills/<name>/`): rejeita o que escaparia dele. */
function assertValidSkillName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new HexlogError('INTERNAL', `invalid skill name: ${JSON.stringify(name)}`);
  }
}

/** Copia a pasta de uma skill (`SKILL.md` + `references/` etc.) para
 * `<home>/.claude/skills/<name>/`, com troca atômica via `swapDirectory` — mesmo
 * mecanismo de `swapArtifact`, com rollback incluso — pra uma falha no meio da
 * cópia ou da troca nunca deixar o destino ausente ou parcial. Sobrescreve sem
 * backup (decisão do usuário; diferente de `registerGuard`, que preserva
 * `.bak-hexlog`). Os temporários ficam ao lado de `skills/`, em `<home>/.claude/` (mesmo
 * filesystem, então o `rename` segue atômico): o Claude Code varre `skills/*`, e um
 * temporário que sobrasse ali apareceria como skill. */
export function writeSkillFolder(home: string, name: string, srcDir: string): void {
  assertValidSkillName(name);
  const claudeDir = path.join(home, '.claude');
  const dstDir = path.join(claudeDir, 'skills', name);
  const tmp = path.join(claudeDir, `.hexlog-skill-${name}.tmp-${process.pid}`);
  const old = path.join(claudeDir, `.hexlog-skill-${name}.old-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(srcDir, tmp, { recursive: true });
    mkdirSync(path.dirname(dstDir), { recursive: true });
    swapDirectory(tmp, dstDir, old);
  } finally {
    // Sucesso: `tmp` já virou `dstDir`. Falha: não deixa o temporário para trás.
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Versão instalada segundo o `command` do hook já registrado em `settings.json`, se houver. */
function registeredHookVersion(settingsData: unknown, home: string): string | undefined {
  const found = findHookEntry(settingsData, libDirOf(home));
  return isNil(found) ? undefined : path.basename(path.dirname(found.file));
}

/** `install.ts --check` (QN4): mesmo `verifyGuard` de I5-I7, mais o aviso de artefato desatualizado. */
export function verifyInstallation(args: {
  home: string;
  version: string;
  execPath: string;
  D: string;
  skillNames: string[];
  currentBundles: Bundles | null;
  settingsText: string | null;
  claudeJsonText: string | null;
  runHook: (exec: string, file: string, stdin: string) => { status: number | null };
  currentHead: string | null;
}): { missing: MissingItem[]; warnings: string[]; exit: 0 | 1 } {
  const {
    home,
    version,
    execPath,
    D,
    skillNames,
    currentBundles,
    settingsText,
    claudeJsonText,
    runHook,
    currentHead,
  } = args;
  // Sem settings, tudo dá "faltando" pelas checagens normais de `verifyGuard` — não precisa de um caso especial.
  const textToVerify = settingsText ?? '{}';
  const installedVersion = registeredHookVersion(parseJsonc(textToVerify), home) ?? version;
  const expected = expectedRules(D, home, execPath, installedVersion);

  const manifest = readManifest(expected.versionDir);
  const installed = installedShas(expected.versionDir);
  // Arquivo ausente não conta como modificado: já sai como `hook-file` em `verifyGuard`.
  const artifactModified =
    !isNil(manifest) &&
    !shasEqual(
      {
        server: installed.server ?? manifest.sha256.server,
        hook: installed.hook ?? manifest.sha256.hook,
      },
      manifest.sha256,
    );

  const result = verifyGuard({
    settingsText: textToVerify,
    claudeJsonText,
    expected,
    exists: existsSync,
    runHook,
    artifactModified,
  });
  for (const name of skillNames) {
    if (!existsSync(skillFileOf(home, name))) result.missing.push(`skill-file:${name}`);
  }

  const warnings: string[] = [];
  if (!isNil(manifest) && !isNil(currentBundles) && !result.missing.includes('artifact-modified')) {
    if (!shasEqual(shasOf(currentBundles), manifest.sha256)) {
      const dirtyText = manifest.dirty ? ' (dirty)' : '';
      const headText = currentHead ?? 'unknown HEAD';
      warnings.push(
        `artifact-outdated: installed from ${manifest.commit ?? 'unknown commit'}${dirtyText}; working tree at ${headText}; run the installer`,
      );
    }
  }

  return { missing: result.missing, warnings, exit: result.missing.length > 0 ? 1 : 0 };
}
