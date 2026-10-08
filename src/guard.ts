// Guard de instalação: regras de deny + hook PreToolUse em
// `settings.json`, e verificação de que o guard está de fato ativo e
// funcionando (I5, I6, I7). Puro e testável; não é importado pelo servidor
// nem pelo hook — só pelo instalador (`scripts/install.ts`).
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, modify, applyEdits, type ModificationOptions } from 'jsonc-parser';
import { parse as shellQuoteParse, quote as shellQuoteQuote } from 'shell-quote';
import { isEqual, isNil, isPlainObject, isString, isSubset, isUndefined } from 'es-toolkit';
import { invalidInput } from './errors.ts';

export type ExpectedRules = {
  dataDir: string;
  libDir: string;
  denyReadDir: string;
  denyRead: string;
  denyEdit: string;
  denyEditLib: string;
  execPath: string;
  hookFile: string;
  hookCommand: string;
  serverFile: string;
  versionDir: string;
};

export type MissingItem =
  | 'deny-read-dir'
  | 'deny-read'
  | 'deny-edit'
  | 'deny-edit-lib'
  | 'hook'
  | 'hook-matcher'
  | 'hook-file'
  | 'node'
  | 'hook-not-denying'
  | 'hook-not-allowing'
  | 'artifact-modified'
  | 'mcp'
  | `skill-file:${string}`;

const HOOK_MATCHER = '^Bash$';
const HOOK_TYPE = 'command';

/** As 4 regras de deny, na ordem em que `applyMissingDeny` as grava e `verifyDeny` as reporta. */
const DENY_RULES = [
  { key: 'denyReadDir', item: 'deny-read-dir' },
  { key: 'denyRead', item: 'deny-read' },
  { key: 'denyEdit', item: 'deny-edit' },
  { key: 'denyEditLib', item: 'deny-edit-lib' },
] as const satisfies readonly { key: keyof ExpectedRules; item: MissingItem }[];

/** Pasta das versões instaladas (`~/.local/lib/hexlog`); `archive.ts` e o instalador também a usam. */
export function libDirOf(home: string): string {
  return path.join(home, '.local', 'lib', 'hexlog');
}

/** As 3 regras de deny de um diretório de dados `D`. */
function denyTrio(D: string): Pick<ExpectedRules, 'denyReadDir' | 'denyRead' | 'denyEdit'> {
  return { denyReadDir: `Read(/${D})`, denyRead: `Read(/${D}/**)`, denyEdit: `Edit(/${D}/**)` };
}

/** `SKILL.md` instalado da skill `name`. */
export function skillFileOf(home: string, name: string): string {
  return path.join(home, '.claude', 'skills', name, 'SKILL.md');
}

/** As 4 regras de deny e os caminhos do hook/servidor instalados para uma versão (QN4). */
export function expectedRules(
  D: string,
  home: string,
  execPath: string,
  version: string,
): ExpectedRules {
  const libDir = libDirOf(home);
  const versionDir = path.join(libDir, version);
  const hookFile = path.join(versionDir, 'bash-guard.mjs');
  return {
    dataDir: D,
    libDir,
    ...denyTrio(D),
    denyEditLib: `Edit(/${libDir}/**)`,
    execPath,
    hookFile,
    // O `command` do settings é interpretado por shell: caminho com espaço precisa de aspas.
    hookCommand: shellQuoteQuote([execPath, hookFile]),
    serverFile: path.join(versionDir, 'server.mjs'),
    versionDir,
  };
}

const FORMATTING_OPTIONS: ModificationOptions = {
  formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' },
};

/** Forma mínima de `settings.json` usada por este módulo — `parse` (jsonc-parser) devolve `any`. */
type SettingsData = {
  permissions?: { deny?: unknown };
};

/** Forma mínima de `~/.claude.json` usada por `mcpRegistered` — `parse` devolve `any`. */
type ClaudeJsonData = {
  mcpServers?: { hexlog?: { command?: unknown; args?: unknown } };
};

/** `permissions.deny` de um `settings.json` já parseado (`parse` do jsonc-parser devolve `any`). */
export function denyOf(settingsData: unknown): unknown[] {
  const deny = (settingsData as SettingsData | undefined)?.permissions?.deny;
  return Array.isArray(deny) ? deny : [];
}

/** `INVALID_INPUT` de um valor existente do tipo errado em `jsonPath` (a raiz é o caminho vazio). */
function wrongType(jsonPath: (string | number)[], code: string, expectedType: string) {
  // O instalador imprime só `error.message`, então o caminho vai nela.
  return invalidInput(
    jsonPath.map((key) => `/${key}`).join(''),
    code,
    `settings.json: ${jsonPath.join('.') || '<root>'} is not ${expectedType}`,
  );
}

/**
 * Acrescenta `value` ao array em `jsonPath`; recusa (`INVALID_INPUT`) um ancestral existente que não
 * seja objeto ou um destino existente que não seja array, antes de qualquer escrita.
 */
function appendToArray(text: string, jsonPath: (string | number)[], value: unknown): string {
  let node: unknown = parse(text);
  for (const [depth, key] of jsonPath.entries()) {
    if (!isUndefined(node) && !isPlainObject(node)) {
      throw wrongType(jsonPath.slice(0, depth), 'not-object', 'an object');
    }
    node = (node as Record<string | number, unknown> | undefined)?.[key];
  }
  if (!isUndefined(node) && !Array.isArray(node))
    throw wrongType(jsonPath, 'not-array', 'an array');
  const edits = modify(text, [...jsonPath, -1], value, FORMATTING_OPTIONS);
  return applyEdits(text, edits);
}

/** Insere cada uma das 4 regras de deny ausentes em `permissions.deny` (idempotente). */
function applyMissingDeny(settingsText: string, expected: ExpectedRules): string {
  const currentDeny = denyOf(parse(settingsText));
  let text = settingsText;
  for (const { key } of DENY_RULES) {
    const rule = expected[key];
    if (currentDeny.includes(rule)) continue;
    text = appendToArray(text, ['permissions', 'deny'], rule);
  }
  return text;
}

/**
 * Regras de deny de um `<D>` antigo que o instalador pode remover: só o trio de `expectedRules`
 * (`denyReadDir`, `denyRead`, `denyEdit`) de um mesmo `X` com basename `hexlog`, `X` diferente do
 * `<D>` atual e `X` ausente do disco (`exists`): um `X` que ainda existe pode guardar log, e o deny
 * é o isolamento dele. Um trio incompleto, outro basename ou regra avulsa do usuário nunca entra.
 */
export function staleDenyRules(
  currentDeny: unknown[],
  expected: ExpectedRules,
  exists: (path: string) => boolean,
): Set<string> {
  const stale = new Set<string>();
  for (const rule of currentDeny) {
    if (!isString(rule) || !rule.startsWith('Read(/') || !rule.endsWith(')')) continue;
    const oldD = rule.slice('Read(/'.length, -')'.length);
    if (path.basename(oldD) !== 'hexlog' || oldD === expected.dataDir || exists(oldD)) continue;
    const rules = Object.values(denyTrio(oldD));
    if (isSubset(currentDeny, rules)) rules.forEach((r) => stale.add(r));
  }
  return stale;
}

/**
 * Remove de `permissions.deny` o trio de um `<D>` antigo (ver `staleDenyRules`); idempotente.
 * Regrava o array inteiro: `modify` por índice do `jsonc-parser` devolve edição errada ao remover o
 * último elemento com o `]` na mesma linha. Custo: comentários dentro de `deny` não sobrevivem.
 */
function removeStaleDeny(settingsText: string, currentDeny: unknown[], stale: Set<string>): string {
  if (stale.size === 0) return settingsText;
  const kept = currentDeny.filter((rule) => !(isString(rule) && stale.has(rule)));
  return applyEdits(
    settingsText,
    modify(settingsText, ['permissions', 'deny'], kept, FORMATTING_OPTIONS),
  );
}

/** `file` é um `bash-guard.mjs` sob `<home>/.local/lib/hexlog/<qualquer versão>`? Chave estável entre versões. */
function isHexlogHookFile(file: string, libDir: string): boolean {
  return path.basename(file) === 'bash-guard.mjs' && path.dirname(path.dirname(file)) === libDir;
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

export type FoundHookEntry = {
  entryIndex: number;
  hookIndex: number;
  exec: string;
  file: string;
  matcher: unknown;
  type: unknown;
  /** Todos os hooks da entrada, o do hexlog inclusive (em `hookIndex`). */
  entryHooks: object[];
};

/** Percorre `hooks.PreToolUse` procurando a entrada do hook do hexlog, em qualquer versão instalada. */
export function findHookEntry(settingsData: unknown, libDir: string): FoundHookEntry | undefined {
  const preToolUse = (settingsData as { hooks?: { PreToolUse?: unknown } })?.hooks?.PreToolUse;
  const entries = (Array.isArray(preToolUse) ? preToolUse : []) as {
    matcher?: unknown;
    hooks?: unknown[];
  }[];
  for (const [entryIndex, entry] of entries.entries()) {
    const hooks = (entry?.hooks ?? []) as { command?: unknown; type?: unknown }[];
    for (const [hookIndex, hook] of hooks.entries()) {
      if (!isString(hook.command)) continue;
      const pair = tryParseCommand(hook.command);
      if (isNil(pair)) continue;
      const [exec, file] = pair;
      if (isHexlogHookFile(file, libDir)) {
        const { matcher } = entry;
        return { entryIndex, hookIndex, exec, file, matcher, type: hook.type, entryHooks: hooks };
      }
    }
  }
  return undefined;
}

/**
 * Insere ou corrige (sem duplicar) a entrada do hook do hexlog em `hooks.PreToolUse`. Regrava no
 * lugar só o campo errado (`command`, `matcher` ou `type`). A exceção é o `matcher` errado numa
 * entrada que divide `hooks` com hooks alheios: o `matcher` é da entrada inteira, então o hook do
 * hexlog sai para uma entrada própria `^Bash$` e a original, com os outros hooks, fica como estava.
 */
function applyHook(settingsText: string, expected: ExpectedRules): string {
  const found = findHookEntry(parse(settingsText), expected.libDir);
  if (isNil(found)) {
    const newEntry = {
      matcher: HOOK_MATCHER,
      hooks: [{ type: HOOK_TYPE, command: expected.hookCommand, timeout: 10 }],
    };
    return appendToArray(settingsText, ['hooks', 'PreToolUse'], newEntry);
  }
  const entryPath = ['hooks', 'PreToolUse', found.entryIndex];
  const hookPath = [...entryPath, 'hooks', found.hookIndex];
  if (found.matcher !== HOOK_MATCHER && found.entryHooks.length > 1) {
    const others = modify(
      settingsText,
      [...entryPath, 'hooks'],
      found.entryHooks.filter((_, index) => index !== found.hookIndex),
      FORMATTING_OPTIONS,
    );
    const ownEntry = {
      matcher: HOOK_MATCHER,
      hooks: [
        { ...found.entryHooks[found.hookIndex], type: HOOK_TYPE, command: expected.hookCommand },
      ],
    };
    return appendToArray(applyEdits(settingsText, others), ['hooks', 'PreToolUse'], ownEntry);
  }
  const repairs: [(string | number)[], string][] = [];
  if (found.exec !== expected.execPath || found.file !== expected.hookFile) {
    repairs.push([[...hookPath, 'command'], expected.hookCommand]);
  }
  if (found.matcher !== HOOK_MATCHER) repairs.push([[...entryPath, 'matcher'], HOOK_MATCHER]);
  if (found.type !== HOOK_TYPE) repairs.push([[...hookPath, 'type'], HOOK_TYPE]);
  return repairs.reduce(
    (text, [jsonPath, value]) =>
      applyEdits(text, modify(text, jsonPath, value, FORMATTING_OPTIONS)),
    settingsText,
  );
}

/**
 * Aplica as 4 regras de deny e o hook faltantes e remove o deny de um `<D>` antigo, sem tocar em mais
 * nada (I5). `removed` lista as regras de deny que saíram (ver `staleDenyRules`).
 */
export function applyGuard(
  settingsText: string,
  expected: ExpectedRules,
  exists: (path: string) => boolean,
): { text: string; removed: string[] } {
  const currentDeny = denyOf(parse(settingsText));
  const stale = staleDenyRules(currentDeny, expected, exists);
  const withDeny = applyMissingDeny(removeStaleDeny(settingsText, currentDeny, stale), expected);
  return { text: applyHook(withDeny, expected), removed: [...stale] };
}

function verifyDeny(currentDeny: unknown[], expected: ExpectedRules): MissingItem[] {
  return DENY_RULES.filter(({ key }) => !currentDeny.includes(expected[key])).map(
    ({ item }): MissingItem => item,
  );
}

/** `~/.claude.json` já tem `mcpServers.hexlog` apontando para o servidor esperado? */
export function mcpRegistered(claudeJsonText: string | null, expected: ExpectedRules): boolean {
  if (isNil(claudeJsonText)) return false;
  const data = parse(claudeJsonText) as ClaudeJsonData | undefined;
  const server = data?.mcpServers?.hexlog;
  if (isNil(server)) return false;
  return server.command === expected.execPath && isEqual(server.args, [expected.serverFile]);
}

/** As duas entradas de sonda que provam o hook vivo: nega o diretório de dados `D`, permite o resto. */
export function hookProbes(D: string): { deny: string; allow: string } {
  return {
    deny: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cat ${D}/probe` } }),
    allow: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } }),
  };
}

type VerifyGuardArgs = {
  settingsText: string;
  claudeJsonText: string | null;
  expected: ExpectedRules;
  exists: (path: string) => boolean;
  runHook: (exec: string, file: string, stdin: string) => { status: number | null };
  /** Bytes instalados divergem do manifesto (arquivo ausente não conta: sai como `hook-file`). */
  artifactModified: boolean;
};

/** Único mecanismo de detecção de guard ausente, alterado ou quebrado (R-1); usado por `install.ts --check`. */
export function verifyGuard(args: VerifyGuardArgs): {
  ok: boolean;
  missing: MissingItem[];
} {
  const { settingsText, claudeJsonText, expected, exists, runHook, artifactModified } = args;
  const settingsData: unknown = parse(settingsText);
  const missing = verifyDeny(denyOf(settingsData), expected);

  const found = findHookEntry(settingsData, expected.libDir);
  if (isNil(found)) missing.push('hook');
  else if (found.matcher !== HOOK_MATCHER || found.type !== HOOK_TYPE) missing.push('hook-matcher');

  const exec = found?.exec ?? expected.execPath;
  const file = found?.file ?? expected.hookFile;
  const execExists = exists(exec);
  const fileExists = exists(file);
  if (!execExists) missing.push('node');
  if (!fileExists) missing.push('hook-file');

  if (execExists && fileExists) {
    const probes = hookProbes(expected.dataDir);
    if (runHook(exec, file, probes.deny).status !== 2) missing.push('hook-not-denying');
    if (runHook(exec, file, probes.allow).status !== 0) missing.push('hook-not-allowing');
  }

  if (!mcpRegistered(claudeJsonText, expected)) missing.push('mcp');
  if (artifactModified) missing.push('artifact-modified');

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
