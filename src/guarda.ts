// Guard de instalação (§4.14): regras de deny + hook PreToolUse em
// `settings.json`, e verificação de que o guard está de fato ativo e
// funcionando (I5, I6, I7). Puro e testável; não é importado pelo servidor
// nem pelo hook — só pelo instalador (`scripts/instalar.ts`, passo 10b).
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse, modify, applyEdits, type ModificationOptions } from 'jsonc-parser';
import { parse as shellQuoteParse, quote as shellQuoteQuote } from 'shell-quote';
import { isNil, isString } from 'es-toolkit';

export interface RegrasEsperadas {
  denyReadDir: string;
  denyRead: string;
  denyEdit: string;
  denyEditLib: string;
  hookExec: string;
  hookArquivo: string;
  hookCommand: string;
  servidorExec: string;
  servidorArquivo: string;
  dirVersao: string;
}

export type ItemFaltando =
  | 'deny-read-dir'
  | 'deny-read'
  | 'deny-edit'
  | 'deny-edit-lib'
  | 'hook'
  | 'hook-arquivo'
  | 'node'
  | 'hook-nao-nega'
  | 'hook-nao-permite'
  | 'artefato-alterado'
  | 'mcp';

/** As 4 regras de deny e os caminhos do hook/servidor instalados para uma versão (§4.14, QN4). */
export function regrasEsperadas(D: string, home: string, execPath: string, versao: string): RegrasEsperadas {
  const dirVersao = path.join(home, '.local', 'lib', 'hexlog', versao);
  const hookArquivo = path.join(dirVersao, 'guarda-bash.mjs');
  const servidorArquivo = path.join(dirVersao, 'servidor.mjs');
  return {
    denyReadDir: `Read(/${D})`,
    denyRead: `Read(/${D}/**)`,
    denyEdit: `Edit(/${D}/**)`,
    denyEditLib: `Edit(/${home}/.local/lib/hexlog/**)`,
    hookExec: execPath,
    hookArquivo,
    // O `command` do settings é interpretado por shell: caminho com espaço precisa de aspas.
    hookCommand: shellQuoteQuote([execPath, hookArquivo]),
    servidorExec: execPath,
    servidorArquivo,
    dirVersao,
  };
}

const OPCOES_FORMATACAO: ModificationOptions = {
  formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' },
};

function inserirNoFimDoArray(texto: string, caminho: (string | number)[], valor: unknown): string {
  const edits = modify(texto, [...caminho, -1], valor, OPCOES_FORMATACAO);
  return applyEdits(texto, edits);
}

/** Insere cada uma das 4 regras de deny ausentes em `permissions.deny` (idempotente). */
function aplicarDenyFaltantes(textoSettings: string, esperado: RegrasEsperadas): string {
  const regras = [esperado.denyReadDir, esperado.denyRead, esperado.denyEdit, esperado.denyEditLib];
  let texto = textoSettings;
  for (const regra of regras) {
    const denyAtual: unknown[] = parse(texto)?.permissions?.deny ?? [];
    if (denyAtual.includes(regra)) continue;
    texto = inserirNoFimDoArray(texto, ['permissions', 'deny'], regra);
  }
  return texto;
}

/** `arquivo` é um `guarda-bash.mjs` sob `<home>/.local/lib/hexlog/<qualquer versão>`? Chave estável entre versões. */
function ehArquivoDoHookHexlog(arquivo: string, dirVersao: string): boolean {
  const dirHexlogLib = path.dirname(dirVersao);
  return path.basename(arquivo) === 'guarda-bash.mjs' && path.dirname(path.dirname(arquivo)) === dirHexlogLib;
}

function tentarParseComando(comando: string): [string, string] | undefined {
  let tokens;
  try {
    tokens = shellQuoteParse(comando);
  } catch {
    return undefined;
  }
  // Exatamente 2 strings (Critic iter3-7): nada de `command.split(' ')`.
  if (tokens.length !== 2 || !tokens.every(isString)) return undefined;
  return [tokens[0], tokens[1]] as [string, string];
}

interface EntradaHookEncontrada {
  entradaIndex: number;
  hookIndex: number;
  exec: string;
  arquivo: string;
}

/** Percorre `hooks.PreToolUse` procurando a entrada do hook do hexlog, em qualquer versão instalada. */
function localizarEntradaHook(dadosSettings: unknown, dirVersao: string): EntradaHookEncontrada | undefined {
  const entradas = ((dadosSettings as { hooks?: { PreToolUse?: unknown[] } })?.hooks?.PreToolUse ?? []) as {
    hooks?: unknown[];
  }[];
  for (const [entradaIndex, entrada] of entradas.entries()) {
    const hooks = (entrada?.hooks ?? []) as { command?: unknown }[];
    for (const [hookIndex, hook] of hooks.entries()) {
      if (!isString(hook.command)) continue;
      const par = tentarParseComando(hook.command);
      if (isNil(par)) continue;
      const [exec, arquivo] = par;
      if (ehArquivoDoHookHexlog(arquivo, dirVersao)) {
        return { entradaIndex, hookIndex, exec, arquivo };
      }
    }
  }
  return undefined;
}

/** Insere ou corrige (sem duplicar) a entrada do hook do hexlog em `hooks.PreToolUse`. */
function aplicarHook(textoSettings: string, esperado: RegrasEsperadas): string {
  const encontrada = localizarEntradaHook(parse(textoSettings), esperado.dirVersao);
  if (isNil(encontrada)) {
    const novaEntrada = { matcher: '^Bash$', hooks: [{ type: 'command', command: esperado.hookCommand, timeout: 10 }] };
    return inserirNoFimDoArray(textoSettings, ['hooks', 'PreToolUse'], novaEntrada);
  }
  if (encontrada.exec === esperado.hookExec && encontrada.arquivo === esperado.hookArquivo) return textoSettings;
  const caminho = ['hooks', 'PreToolUse', encontrada.entradaIndex, 'hooks', encontrada.hookIndex, 'command'];
  const edits = modify(textoSettings, caminho, esperado.hookCommand, OPCOES_FORMATACAO);
  return applyEdits(textoSettings, edits);
}

/** Aplica as 4 regras de deny e o hook faltantes sobre `settings.json`, sem tocar em mais nada (I5). */
export function aplicarGuard(textoSettings: string, esperado: RegrasEsperadas): string {
  const comDeny = aplicarDenyFaltantes(textoSettings, esperado);
  return aplicarHook(comDeny, esperado);
}

function verificarDeny(denyAtual: unknown[], esperado: RegrasEsperadas): ItemFaltando[] {
  const faltando: ItemFaltando[] = [];
  if (!denyAtual.includes(esperado.denyReadDir)) faltando.push('deny-read-dir');
  if (!denyAtual.includes(esperado.denyRead)) faltando.push('deny-read');
  if (!denyAtual.includes(esperado.denyEdit)) faltando.push('deny-edit');
  if (!denyAtual.includes(esperado.denyEditLib)) faltando.push('deny-edit-lib');
  return faltando;
}

/** `D` extraído de `denyReadDir = 'Read(/' + D + ')'` — evita repetir o parâmetro em todo o módulo. */
function extrairD(esperado: RegrasEsperadas): string {
  return esperado.denyReadDir.slice('Read(/'.length, -')'.length);
}

function verificarMcp(textoClaudeJson: string | null, esperado: RegrasEsperadas): boolean {
  if (isNil(textoClaudeJson)) return false;
  const servidor = parse(textoClaudeJson)?.mcpServers?.hexlog;
  if (isNil(servidor)) return false;
  return (
    servidor.command === esperado.servidorExec &&
    Array.isArray(servidor.args) &&
    servidor.args.length === 1 &&
    servidor.args[0] === esperado.servidorArquivo
  );
}

function verificarArtefatoAlterado(bytesInstalados: ArgsVerificarGuard['bytesInstalados']): boolean {
  if (isNil(bytesInstalados) || isNil(bytesInstalados.manifesto)) return false;
  const { servidor, hook, manifesto } = bytesInstalados;
  const servidorAlterado = !isNil(servidor) && sha256(servidor) !== manifesto.sha256.servidor;
  const hookAlterado = !isNil(hook) && sha256(hook) !== manifesto.sha256.hook;
  return servidorAlterado || hookAlterado;
}

interface ArgsVerificarGuard {
  textoSettings: string;
  textoClaudeJson: string | null;
  esperado: RegrasEsperadas;
  existe: (caminho: string) => boolean;
  executarHook: (exec: string, arquivo: string, stdin: string) => { status: number | null };
  bytesInstalados?: {
    servidor: Buffer | null;
    hook: Buffer | null;
    manifesto: { sha256: { servidor: string; hook: string } } | null;
  };
}

/** Único mecanismo de detecção de guard ausente, alterado ou quebrado (R-1); usado por `instalar.ts --check`. */
export function verificarGuard(args: ArgsVerificarGuard): { ok: boolean; faltando: ItemFaltando[]; avisos: string[] } {
  const { textoSettings, textoClaudeJson, esperado, existe, executarHook, bytesInstalados } = args;
  const dadosSettings = parse(textoSettings);
  const denyAtual: unknown[] = dadosSettings?.permissions?.deny ?? [];
  const faltando = verificarDeny(denyAtual, esperado);

  const encontrada = localizarEntradaHook(dadosSettings, esperado.dirVersao);
  if (isNil(encontrada)) faltando.push('hook');

  const exec = encontrada?.exec ?? esperado.hookExec;
  const arquivo = encontrada?.arquivo ?? esperado.hookArquivo;
  const execExiste = existe(exec);
  const arquivoExiste = existe(arquivo);
  if (!execExiste) faltando.push('node');
  if (!arquivoExiste) faltando.push('hook-arquivo');

  if (execExiste && arquivoExiste) {
    const D = extrairD(esperado);
    const entradaNega = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cat ${D}/sonda` } });
    if (executarHook(exec, arquivo, entradaNega).status !== 2) faltando.push('hook-nao-nega');

    const entradaPermite = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } });
    if (executarHook(exec, arquivo, entradaPermite).status !== 0) faltando.push('hook-nao-permite');
  }

  if (!verificarMcp(textoClaudeJson, esperado)) faltando.push('mcp');
  if (verificarArtefatoAlterado(bytesInstalados)) faltando.push('artefato-alterado');

  return { ok: faltando.length === 0, faltando, avisos: [] };
}

/** Execução real do hook instalado: sem `split`, `arquivo` já resolvido pelo `shellQuote.parse` do `command` registrado. */
export function executarHookReal(exec: string, arquivo: string, stdin: string): { status: number | null } {
  // `env: process.env` explícito (em vez de deixar o spawnSync herdar por
  // omissão): equivalente em produção, mas lê o `process.env` atual — sem
  // isso, o teste que simula um `HOME` diferente (I7) não convence o filho,
  // porque o sandbox do Jest desacopla o `process.env` mutável do ambiente
  // nativo que o `child_process` usaria por omissão.
  const resultado = spawnSync(exec, [arquivo], { input: stdin, timeout: 10_000, env: process.env });
  return { status: resultado.status };
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
