// Instalação versionada do artefato (§4.14): copia os bundles para
// `~/.local/lib/hexlog/<versão>/`, registra o guard em `settings.json` e decide
// se o MCP precisa ser (re)registrado. Puro e testável: toda execução externa
// (hook, servidor, relógio, log) é injetada — nada aqui chama `claude` nem builda.
// Não é importado pelo servidor nem pelo hook, só por `scripts/install.ts`.
import * as path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { isNil } from 'es-toolkit';
import {
  regrasEsperadas,
  aplicarGuard,
  verificarGuard,
  localizarEntradaHook,
  mcpRegistrado,
  sha256,
  sondasDoHook,
  type RegrasEsperadas,
  type ItemFaltando,
} from './guard.ts';
import { HexlogError } from './errors.ts';
import { dirDados } from './directory.ts';

export type Bundles = { servidor: Buffer; hook: Buffer };
export type Manifesto = {
  versao: string;
  sha256: { servidor: string; hook: string };
  construidoEm: string;
  commit: string | null;
  sujo: boolean;
};

// Duplicado de `scripts/build.ts` (não deste arquivo, que é `import`-ado direto
// pelos testes): aquele módulo usa `import.meta.dirname`/`import.meta.main`,
// incompatíveis com o transform CJS do ts-jest.
function temDynamicRequire(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).includes('Dynamic require of');
}

// 5 tools em definition-tools.ts + 5 em event-tools.ts (§4.12/§4.16).
const QUANTIDADE_TOOLS = 10;

export function dirVersaoDe(home: string, versao: string): string {
  return path.join(home, '.local', 'lib', 'hexlog', versao);
}

export function lerManifesto(dirVersao: string): Manifesto | null {
  const arquivo = path.join(dirVersao, 'manifesto.json');
  if (!existsSync(arquivo)) return null;
  try {
    return JSON.parse(readFileSync(arquivo, 'utf8')) as Manifesto;
  } catch {
    return null;
  }
}

function shasInstalados(dirVersao: string): { servidor: string | null; hook: string | null } {
  const shaDoArquivo = (nome: string): string | null => {
    const arquivo = path.join(dirVersao, nome);
    return existsSync(arquivo) ? sha256(readFileSync(arquivo)) : null;
  };
  return { servidor: shaDoArquivo('servidor.mjs'), hook: shaDoArquivo('guarda-bash.mjs') };
}

/** `ENOENT` cobre a reinstalação: o primeiro `renameSync(dirVersao, antiga)` acha `dirVersao` já
 * movido por outro instalador que chegou primeiro — mesma resolução de `ENOTEMPTY`/`EEXIST`. */
function ehErroDeDiretorioOcupado(erro: unknown): boolean {
  if (!(erro instanceof Error)) return false;
  const codigo = (erro as NodeJS.ErrnoException).code;
  return codigo === 'ENOTEMPTY' || codigo === 'EEXIST' || codigo === 'ENOENT';
}

/** Verifica o artefato preparado em `tmp` antes de trocar (§4.14): qualquer falha aborta sem tocar em nada. */
async function verificarArtefatoPreparado(args: {
  tmp: string;
  bundles: Bundles;
  executarHook: (arquivoHook: string, stdin: string) => { status: number | null };
  verificarServidor: (arquivoServidor: string) => Promise<number>;
}): Promise<void> {
  const { tmp, bundles, executarHook, verificarServidor } = args;
  if (temDynamicRequire(bundles.servidor) || temDynamicRequire(bundles.hook)) {
    throw new HexlogError('INTERNAL', 'bundle contém "Dynamic require of"; instalação abortada');
  }

  // Mesma checagem funcional de `verificarGuard` (nega o diretório de dados, permite o resto),
  // mas contra o hook recém-preparado em `tmp`, antes de virar o hook instalado de verdade.
  const arquivoHook = path.join(tmp, 'guarda-bash.mjs');
  const sondas = sondasDoHook(dirDados(process.env));
  if (executarHook(arquivoHook, sondas.nega).status !== 2) {
    throw new HexlogError('INTERNAL', 'hook preparado não nega o acesso ao diretório de dados');
  }
  if (executarHook(arquivoHook, sondas.permite).status !== 0) {
    throw new HexlogError('INTERNAL', 'hook preparado não permite comandos inofensivos');
  }

  let quantidadeTools: number;
  try {
    quantidadeTools = await verificarServidor(path.join(tmp, 'servidor.mjs'));
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    throw new HexlogError('INTERNAL', `servidor preparado falhou ao iniciar: ${mensagem}`);
  }
  if (quantidadeTools !== QUANTIDADE_TOOLS) {
    throw new HexlogError(
      'INTERNAL',
      `servidor preparado listou ${quantidadeTools} tools, esperado ${QUANTIDADE_TOOLS}`,
    );
  }
}

/** Reage a um `renameSync` que achou `dirVersao` ocupado: outro instalador pode ter terminado primeiro. */
function resolverConcorrencia(
  erro: unknown,
  tmp: string,
  dirVersao: string,
  shaBuild: { servidor: string; hook: string },
  versao: string,
): { acao: 'nada'; avisoExtra: null } {
  if (!ehErroDeDiretorioOcupado(erro)) {
    rmSync(tmp, { recursive: true, force: true });
    throw erro;
  }
  const instaladosAgora = shasInstalados(dirVersao);
  rmSync(tmp, { recursive: true, force: true });
  if (instaladosAgora.servidor === shaBuild.servidor && instaladosAgora.hook === shaBuild.hook) {
    return { acao: 'nada', avisoExtra: null };
  }
  throw new HexlogError(
    'INTERNAL',
    `outra instalação trocou ${versao} ao mesmo tempo; rode o instalador de novo`,
  );
}

/** Troca atômica de `tmp` para `dirVersao` (§4.14), cobrindo instalação nova, reinstalação e concorrência. */
function trocarArtefato(args: {
  dirVersao: string;
  tmp: string;
  existeAntes: boolean;
  shaBuild: { servidor: string; hook: string };
  alteracaoDetectada: boolean;
  versao: string;
}): { acao: 'instalado' | 'reinstalado' | 'reparado' | 'nada'; avisoExtra: string | null } {
  const { dirVersao, tmp, existeAntes, shaBuild, alteracaoDetectada, versao } = args;

  if (!existeAntes) {
    try {
      renameSync(tmp, dirVersao);
      return { acao: 'instalado', avisoExtra: null };
    } catch (erro) {
      return resolverConcorrencia(erro, tmp, dirVersao, shaBuild, versao);
    }
  }

  const antiga = path.join(path.dirname(dirVersao), `.${versao}.antiga-${Date.now()}`);
  try {
    renameSync(dirVersao, antiga);
    renameSync(tmp, dirVersao);
    rmSync(antiga, { recursive: true, force: true });
  } catch (erro) {
    // Desfaz o primeiro rename se o segundo falhou, pra não deixar `dirVersao` ausente.
    if (existsSync(antiga) && !existsSync(dirVersao)) renameSync(antiga, dirVersao);
    return resolverConcorrencia(erro, tmp, dirVersao, shaBuild, versao);
  }
  if (alteracaoDetectada) return { acao: 'reparado', avisoExtra: null };
  return {
    acao: 'reinstalado',
    avisoExtra: `versão ${versao} reinstalada com conteúdo diferente; considere subir a versão`,
  };
}

/** Instala os bundles preparados como a versão ativa, idempotente pelos bytes instalados (§4.14). */
export async function instalarArtefato(args: {
  home: string;
  versao: string;
  bundles: Bundles;
  commit: string | null;
  sujo: boolean;
  agora: () => Date;
  executarHook: (arquivoHook: string, stdin: string) => { status: number | null };
  verificarServidor: (arquivoServidor: string) => Promise<number>;
  log: (mensagem: string) => void;
}): Promise<{
  acao: 'nada' | 'instalado' | 'reinstalado' | 'reparado';
  dirVersao: string;
  manifesto: Manifesto;
  avisos: string[];
}> {
  const { home, versao, bundles, commit, sujo, agora, executarHook, verificarServidor, log } = args;
  const dirVersao = dirVersaoDe(home, versao);
  const shaBuild = { servidor: sha256(bundles.servidor), hook: sha256(bundles.hook) };
  const manifestoAntigo = lerManifesto(dirVersao);
  const instalados = shasInstalados(dirVersao);
  const existeAntes = existsSync(dirVersao);

  if (instalados.servidor === shaBuild.servidor && instalados.hook === shaBuild.hook) {
    log(`versão ${versao} já instalada e íntegra; nada a fazer`);
    return {
      acao: 'nada',
      dirVersao,
      manifesto: manifestoAntigo ?? {
        versao,
        sha256: shaBuild,
        construidoEm: agora().toISOString(),
        commit,
        sujo,
      },
      avisos: [],
    };
  }

  // Divergem do build; se também divergem do próprio manifesto, o artefato instalado foi
  // alterado por fora (não é uma reinstalação normal com bundles novos) — repara e avisa.
  const alteracaoDetectada =
    !isNil(manifestoAntigo) &&
    (instalados.servidor !== manifestoAntigo.sha256.servidor ||
      instalados.hook !== manifestoAntigo.sha256.hook);
  const avisos: string[] = [];
  if (alteracaoDetectada) {
    avisos.push('artefato instalado alterado; reparando');
    log('artefato instalado alterado; reparando');
  }

  const manifesto: Manifesto = {
    versao,
    sha256: shaBuild,
    construidoEm: agora().toISOString(),
    commit,
    sujo,
  };
  const tmp = path.join(path.dirname(dirVersao), `.${versao}.tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    writeFileSync(path.join(tmp, 'servidor.mjs'), bundles.servidor, { mode: 0o644 });
    writeFileSync(path.join(tmp, 'guarda-bash.mjs'), bundles.hook, { mode: 0o644 });
    writeFileSync(path.join(tmp, 'manifesto.json'), JSON.stringify(manifesto, null, 2), {
      mode: 0o644,
    });
    await verificarArtefatoPreparado({ tmp, bundles, executarHook, verificarServidor });
  } catch (erro) {
    rmSync(tmp, { recursive: true, force: true });
    throw erro;
  }

  const { acao, avisoExtra } = trocarArtefato({
    dirVersao,
    tmp,
    existeAntes,
    shaBuild,
    alteracaoDetectada,
    versao,
  });
  if (!isNil(avisoExtra)) avisos.push(avisoExtra);

  const manifestoFinal = acao === 'nada' ? (lerManifesto(dirVersao) ?? manifesto) : manifesto;
  log(`versão ${versao}: ${acao}`);
  return { acao, dirVersao, manifesto: manifestoFinal, avisos };
}

/** Aplica o guard em `settings.json` (backup + troca atômica), só se algo mudou. */
export function registrarGuard(args: { caminhoSettings: string; esperado: RegrasEsperadas }): {
  mudou: boolean;
} {
  const { caminhoSettings, esperado } = args;
  if (!existsSync(caminhoSettings)) {
    throw new HexlogError('INTERNAL', 'instale o harness antes de instalar o hexlog');
  }
  const textoAntigo = readFileSync(caminhoSettings, 'utf8');
  const textoNovo = aplicarGuard(textoAntigo, esperado);
  if (textoNovo === textoAntigo) return { mudou: false };

  writeFileSync(`${caminhoSettings}.bak-hexlog`, textoAntigo);
  const tmp = `${caminhoSettings}.tmp-${process.pid}`;
  writeFileSync(tmp, textoNovo);
  renameSync(tmp, caminhoSettings);
  return { mudou: true };
}

/** `~/.claude.json` ainda não aponta `mcpServers.hexlog` para o servidor esperado. */
export function precisaRegistrarMcp(
  textoClaudeJson: string | null,
  esperado: RegrasEsperadas,
): boolean {
  return !mcpRegistrado(textoClaudeJson, esperado);
}

/** Versão instalada segundo o `command` do hook já registrado em `settings.json`, se houver. */
function versaoDoHookRegistrado(dadosSettings: unknown, home: string): string | undefined {
  // `localizarEntradaHook` só usa `dirname(dirVersao)` (o diretório `.local/lib/hexlog`) para
  // reconhecer o hook do hexlog em qualquer versão — o segmento de versão em si é irrelevante aqui.
  const dirVersaoQualquer = path.join(home, '.local', 'lib', 'hexlog', '_');
  const encontrada = localizarEntradaHook(dadosSettings, dirVersaoQualquer);
  return isNil(encontrada) ? undefined : path.basename(path.dirname(encontrada.arquivo));
}

/** `install.ts --check` (§4.14, §10; QN4): mesmo `verificarGuard` de I5-I7, mais o aviso de artefato desatualizado. */
export function verificarInstalacao(args: {
  home: string;
  versao: string;
  execPath: string;
  D: string;
  bundlesAtuais: Bundles | null;
  textoSettings: string | null;
  textoClaudeJson: string | null;
  executarHook: (exec: string, arquivo: string, stdin: string) => { status: number | null };
  headAtual: string | null;
}): { faltando: ItemFaltando[]; avisos: string[]; exit: 0 | 1 } {
  const {
    home,
    versao,
    execPath,
    D,
    bundlesAtuais,
    textoSettings,
    textoClaudeJson,
    executarHook,
    headAtual,
  } = args;
  // Sem settings, tudo dá "faltando" pelas checagens normais de `verificarGuard` — não precisa de um caso especial.
  const textoParaVerificar = textoSettings ?? '{}';
  const versaoInstalada = versaoDoHookRegistrado(parseJsonc(textoParaVerificar), home) ?? versao;
  const esperado = regrasEsperadas(D, home, execPath, versaoInstalada);

  const manifesto = lerManifesto(esperado.dirVersao);
  const bytesInstalados = isNil(manifesto)
    ? undefined
    : {
        servidor: existsSync(esperado.servidorArquivo)
          ? readFileSync(esperado.servidorArquivo)
          : null,
        hook: existsSync(esperado.hookArquivo) ? readFileSync(esperado.hookArquivo) : null,
        manifesto,
      };

  const resultado = verificarGuard({
    textoSettings: textoParaVerificar,
    textoClaudeJson,
    esperado,
    existe: existsSync,
    executarHook,
    bytesInstalados,
  });

  const avisos: string[] = [];
  if (
    !isNil(manifesto) &&
    !isNil(bundlesAtuais) &&
    !resultado.faltando.includes('artefato-alterado')
  ) {
    const shaBuild = { servidor: sha256(bundlesAtuais.servidor), hook: sha256(bundlesAtuais.hook) };
    const desatualizado =
      shaBuild.servidor !== manifesto.sha256.servidor || shaBuild.hook !== manifesto.sha256.hook;
    if (desatualizado) {
      const sujoTexto = manifesto.sujo ? ' (sujo)' : '';
      const headTexto = headAtual ?? 'HEAD desconhecido';
      avisos.push(
        `artefato-desatualizado: instalado de ${manifesto.commit ?? 'commit desconhecido'}${sujoTexto}; working tree em ${headTexto}; rode o instalador`,
      );
    }
  }

  return { faltando: resultado.faltando, avisos, exit: resultado.faltando.length > 0 ? 1 : 0 };
}
