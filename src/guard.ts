// Guard de instalação (§4.14): regras de deny + hook PreToolUse em
// `settings.json`, e verificação de que o guard está de fato ativo e
// funcionando (I5, I6, I7). Puro e testável; não é importado pelo servidor
// nem pelo hook — só pelo instalador (`scripts/install.ts`).
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse, modify, applyEdits, type ModificationOptions } from 'jsonc-parser';
import { parse as shellQuoteParse, quote as shellQuoteQuote } from 'shell-quote';
import { isNil, isString } from 'es-toolkit';

export interface ExpectedRules {
  denyReadDir: string;
  denyRead: string;
  denyEdit: string;
  denyEditLib: string;
  hookExec: string;
  hookFile: string;
  hookCommand: string;
  serverExec: string;
  serverFile: string;
  versionDir: string;
  skillFile: string;
}

export type MissingItem =
  | 'deny-read-dir'
  | 'deny-read'
  | 'deny-edit'
  | 'deny-edit-lib'
  | 'hook'
  | 'hook-file'
  | 'node'
  | 'hook-not-denying'
  | 'hook-not-allowing'
  | 'artifact-modified'
  | 'mcp'
  | 'skill-file';

/** As 4 regras de deny e os caminhos do hook/servidor instalados para uma versão (§4.14, QN4). */
export function expectedRules(
  D: string,
  home: string,
  execPath: string,
  version: string,
): ExpectedRules {
  const versionDir = path.join(home, '.local', 'lib', 'hexlog', version);
  const hookFile = path.join(versionDir, 'bash-guard.mjs');
  const serverFile = path.join(versionDir, 'server.mjs');
  return {
    denyReadDir: `Read(/${D})`,
    denyRead: `Read(/${D}/**)`,
    denyEdit: `Edit(/${D}/**)`,
    denyEditLib: `Edit(/${home}/.local/lib/hexlog/**)`,
    hookExec: execPath,
    hookFile,
    // O `command` do settings é interpretado por shell: caminho com espaço precisa de aspas.
    hookCommand: shellQuoteQuote([execPath, hookFile]),
    serverExec: execPath,
    serverFile,
    versionDir,
    skillFile: path.join(home, '.claude', 'skills', 'hexlog', 'SKILL.md'),
  };
}

const FORMATTING_OPTIONS: ModificationOptions = {
  formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' },
};

/** Forma mínima de `settings.json` usada por este módulo — `parse` (jsonc-parser) devolve `any`. */
interface SettingsData {
  permissions?: { deny?: unknown[] };
}

/** Forma mínima de `~/.claude.json` usada por `mcpRegistered` — `parse` devolve `any`. */
interface ClaudeJsonData {
  mcpServers?: { hexlog?: { command?: unknown; args?: unknown } };
}

function appendToArray(text: string, jsonPath: (string | number)[], value: unknown): string {
  const edits = modify(text, [...jsonPath, -1], value, FORMATTING_OPTIONS);
  return applyEdits(text, edits);
}

/** Insere cada uma das 4 regras de deny ausentes em `permissions.deny` (idempotente). */
function applyMissingDeny(settingsText: string, expected: ExpectedRules): string {
  const rules = [expected.denyReadDir, expected.denyRead, expected.denyEdit, expected.denyEditLib];
  let text = settingsText;
  for (const rule of rules) {
    const data = parse(text) as SettingsData | undefined;
    const currentDeny: unknown[] = data?.permissions?.deny ?? [];
    if (currentDeny.includes(rule)) continue;
    text = appendToArray(text, ['permissions', 'deny'], rule);
  }
  return text;
}

/** `file` é um `bash-guard.mjs` sob `<home>/.local/lib/hexlog/<qualquer versão>`? Chave estável entre versões. */
function isHexlogHookFile(file: string, versionDir: string): boolean {
  const hexlogLibDir = path.dirname(versionDir);
  return (
    path.basename(file) === 'bash-guard.mjs' && path.dirname(path.dirname(file)) === hexlogLibDir
  );
}

function tryParseCommand(command: string): [string, string] | undefined {
  let tokens;
  try {
    tokens = shellQuoteParse(command);
  } catch {
    return undefined;
  }
  // Exatamente 2 strings (Critic iter3-7): nada de `command.split(' ')`.
  if (tokens.length !== 2 || !tokens.every(isString)) return undefined;
  return [tokens[0], tokens[1]] as [string, string];
}

export interface FoundHookEntry {
  entryIndex: number;
  hookIndex: number;
  exec: string;
  file: string;
}

/** Percorre `hooks.PreToolUse` procurando a entrada do hook do hexlog, em qualquer versão instalada. */
export function findHookEntry(
  settingsData: unknown,
  versionDir: string,
): FoundHookEntry | undefined {
  const entries = ((settingsData as { hooks?: { PreToolUse?: unknown[] } })?.hooks?.PreToolUse ??
    []) as {
    hooks?: unknown[];
  }[];
  for (const [entryIndex, entry] of entries.entries()) {
    const hooks = (entry?.hooks ?? []) as { command?: unknown }[];
    for (const [hookIndex, hook] of hooks.entries()) {
      if (!isString(hook.command)) continue;
      const pair = tryParseCommand(hook.command);
      if (isNil(pair)) continue;
      const [exec, file] = pair;
      if (isHexlogHookFile(file, versionDir)) {
        return { entryIndex, hookIndex, exec, file };
      }
    }
  }
  return undefined;
}

/** Insere ou corrige (sem duplicar) a entrada do hook do hexlog em `hooks.PreToolUse`. */
function applyHook(settingsText: string, expected: ExpectedRules): string {
  const found = findHookEntry(parse(settingsText), expected.versionDir);
  if (isNil(found)) {
    const newEntry = {
      matcher: '^Bash$',
      hooks: [{ type: 'command', command: expected.hookCommand, timeout: 10 }],
    };
    return appendToArray(settingsText, ['hooks', 'PreToolUse'], newEntry);
  }
  if (found.exec === expected.hookExec && found.file === expected.hookFile) return settingsText;
  const jsonPath = ['hooks', 'PreToolUse', found.entryIndex, 'hooks', found.hookIndex, 'command'];
  const edits = modify(settingsText, jsonPath, expected.hookCommand, FORMATTING_OPTIONS);
  return applyEdits(settingsText, edits);
}

/** Aplica as 4 regras de deny e o hook faltantes sobre `settings.json`, sem tocar em mais nada (I5). */
export function applyGuard(settingsText: string, expected: ExpectedRules): string {
  const withDeny = applyMissingDeny(settingsText, expected);
  return applyHook(withDeny, expected);
}

function verifyDeny(currentDeny: unknown[], expected: ExpectedRules): MissingItem[] {
  const missing: MissingItem[] = [];
  if (!currentDeny.includes(expected.denyReadDir)) missing.push('deny-read-dir');
  if (!currentDeny.includes(expected.denyRead)) missing.push('deny-read');
  if (!currentDeny.includes(expected.denyEdit)) missing.push('deny-edit');
  if (!currentDeny.includes(expected.denyEditLib)) missing.push('deny-edit-lib');
  return missing;
}

/** `D` extraído de `denyReadDir = 'Read(/' + D + ')'` — evita repetir o parâmetro em todo o módulo. */
function extractD(expected: ExpectedRules): string {
  return expected.denyReadDir.slice('Read(/'.length, -')'.length);
}

/** `~/.claude.json` já tem `mcpServers.hexlog` apontando para o servidor esperado? */
export function mcpRegistered(claudeJsonText: string | null, expected: ExpectedRules): boolean {
  if (isNil(claudeJsonText)) return false;
  const data = parse(claudeJsonText) as ClaudeJsonData | undefined;
  const server = data?.mcpServers?.hexlog;
  if (isNil(server)) return false;
  return (
    server.command === expected.serverExec &&
    Array.isArray(server.args) &&
    server.args.length === 1 &&
    server.args[0] === expected.serverFile
  );
}

/** As duas entradas de sonda que provam o hook vivo: nega o diretório de dados `D`, permite o resto. */
export function hookProbes(D: string): { deny: string; allow: string } {
  return {
    deny: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cat ${D}/probe` } }),
    allow: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } }),
  };
}

function verifyArtifactModified(installedBytes: VerifyGuardArgs['installedBytes']): boolean {
  if (isNil(installedBytes) || isNil(installedBytes.manifest)) return false;
  const { server, hook, manifest } = installedBytes;
  const serverModified = !isNil(server) && sha256(server) !== manifest.sha256.server;
  const hookModified = !isNil(hook) && sha256(hook) !== manifest.sha256.hook;
  return serverModified || hookModified;
}

interface VerifyGuardArgs {
  settingsText: string;
  claudeJsonText: string | null;
  expected: ExpectedRules;
  exists: (path: string) => boolean;
  runHook: (exec: string, file: string, stdin: string) => { status: number | null };
  installedBytes?: {
    server: Buffer | null;
    hook: Buffer | null;
    manifest: { sha256: { server: string; hook: string } } | null;
  };
}

/** Único mecanismo de detecção de guard ausente, alterado ou quebrado (R-1); usado por `install.ts --check`. */
export function verifyGuard(args: VerifyGuardArgs): {
  ok: boolean;
  missing: MissingItem[];
} {
  const { settingsText, claudeJsonText, expected, exists, runHook, installedBytes } = args;
  const settingsData = parse(settingsText) as SettingsData | undefined;
  const currentDeny: unknown[] = settingsData?.permissions?.deny ?? [];
  const missing = verifyDeny(currentDeny, expected);

  const found = findHookEntry(settingsData, expected.versionDir);
  if (isNil(found)) missing.push('hook');

  const exec = found?.exec ?? expected.hookExec;
  const file = found?.file ?? expected.hookFile;
  const execExists = exists(exec);
  const fileExists = exists(file);
  if (!execExists) missing.push('node');
  if (!fileExists) missing.push('hook-file');

  if (execExists && fileExists) {
    const probes = hookProbes(extractD(expected));
    if (runHook(exec, file, probes.deny).status !== 2) missing.push('hook-not-denying');
    if (runHook(exec, file, probes.allow).status !== 0) missing.push('hook-not-allowing');
  }

  if (!mcpRegistered(claudeJsonText, expected)) missing.push('mcp');
  if (verifyArtifactModified(installedBytes)) missing.push('artifact-modified');

  return { ok: missing.length === 0, missing };
}

/** Execução real do hook instalado: sem `split`, `file` já resolvido pelo `shellQuote.parse` do `command` registrado. */
export function runRealHook(exec: string, file: string, stdin: string): { status: number | null } {
  // `env: process.env` explícito (em vez de deixar o spawnSync herdar por
  // omissão): equivalente em produção, mas lê o `process.env` atual — sem
  // isso, o teste que simula um `HOME` diferente (I7) não convence o filho,
  // porque o sandbox do Jest desacopla o `process.env` mutável do ambiente
  // nativo que o `child_process` usaria por omissão.
  const result = spawnSync(exec, [file], { input: stdin, timeout: 10_000, env: process.env });
  return { status: result.status };
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
