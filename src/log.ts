import { randomBytes, randomUUIDv7 } from 'node:crypto';
// import default (não `* as fs`): sob esModuleInterop, `* as` copia o módulo com getters
// não configuráveis, o que impede `jest.spyOn(fs, 'fsyncSync')` de interceptar esta chamada
// a partir do teste (test/log.spec.ts precisa espiar o mesmo objeto `fs` que este módulo usa).
import fs from 'node:fs';
import * as path from 'node:path';
import { isEmpty, isNil } from 'es-toolkit/compat';
import { eloValido, prevHashEsperado, proximoSeq } from './chain.ts';
import { ErroHexlog } from './errors.ts';
import type { Linha } from './events.ts';

export type Registro = {
  nivel: 'debug' | 'info' | 'aviso' | 'erro';
  evento: string;
  [campo: string]: unknown;
};
export type Logger = (registro: Registro) => void;

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const LOCK_ORFAO_MS = 10_000;

const ARQUIVO_TOKEN = 'owner';

type Base = {
  seq: number;
  timestamp: string;
  prevHash: string;
  uuid: string;
  ultimoElo: Linha | null;
};

/** Leitura sem lock. Arquivo inexistente conta como log vazio. */
export function lerTexto(arquivo: string): string {
  try {
    return fs.readFileSync(arquivo, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Anexa um elo ao log JSONL sob lock exclusivo por diretório (§4.7). A espera pela aquisição do
 * lock é assíncrona (retry com `await` de sleep); a partir daqui, `montar` roda dentro da seção
 * crítica síncrona (sem `await`): recebe a base já calculada (`seq`/`prevHash`/`uuid`/`timestamp`/
 * `ultimoElo`) e devolve a `Linha` a gravar.
 */
export async function anexar(
  arquivo: string,
  manifesto: unknown,
  montar: (base: Base) => Linha,
  opcoes: { log: Logger; timeoutMs?: number; orfaoMs?: number; relogio?: () => Date },
): Promise<Linha> {
  const {
    log,
    timeoutMs = LOCK_TIMEOUT_MS,
    orfaoMs = LOCK_ORFAO_MS,
    relogio = () => new Date(),
  } = opcoes;
  const dirLock = `${arquivo}.lock`;
  const token = await adquirirLock(dirLock, { log, timeoutMs, orfaoMs });

  try {
    const contexto = prepararContexto(arquivo, manifesto, relogio);
    const linha = montar(contexto);

    if (lerToken(dirLock) !== token) {
      log({ nivel: 'erro', evento: 'lock-perdido' });
      throw new ErroHexlog('LOCK_PERDIDO', 'lock perdido antes da escrita');
    }

    escreverLinha(arquivo, contexto.endsWithNewline, linha);
    return linha;
  } finally {
    liberarLock(dirLock, token);
  }
}

function prepararContexto(
  arquivo: string,
  manifesto: unknown,
  relogio: () => Date,
): Base & { endsWithNewline: boolean } {
  const texto = lerTexto(arquivo);
  const endsWithNewline = isEmpty(texto) || texto.endsWith('\n');
  // A cauda sem '\n' (escrita em andamento ou rasgo ainda não reparado) entra na busca do
  // último elo (mesma regra de verificarCadeia em chain.ts, mas aqui sem descartá-la).
  const linhas = isEmpty(texto) ? [] : texto.split('\n').slice(0, endsWithNewline ? -1 : undefined);
  const { ultimoElo, linhasDepois } = ultimoEloEDepois(linhas);

  return {
    seq: proximoSeq(ultimoElo, linhasDepois),
    timestamp: relogio().toISOString(),
    prevHash: prevHashEsperado(ultimoElo, manifesto),
    uuid: randomUUIDv7(),
    ultimoElo,
    endsWithNewline,
  };
}

/** Primeira linha, de trás pra frente, que passa em `eloValido`; e quantas vêm depois dela. */
function ultimoEloEDepois(linhas: string[]): { ultimoElo: Linha | null; linhasDepois: number } {
  for (let indice = linhas.length - 1; indice >= 0; indice--) {
    const elo = eloValido(linhas[indice]);
    if (!isNil(elo)) return { ultimoElo: elo, linhasDepois: linhas.length - 1 - indice };
  }
  return { ultimoElo: null, linhasDepois: linhas.length };
}

function escreverLinha(arquivo: string, endsWithNewline: boolean, linha: Linha): void {
  const fd = fs.openSync(arquivo, 'a', 0o600);
  try {
    fs.writeSync(fd, `${endsWithNewline ? '' : '\n'}${JSON.stringify(linha)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
// ponytail: reread O(n) por append; medido ~18 ms a 10k linhas com fsync; upgrade: sidecar de tail/índice.

async function adquirirLock(
  dirLock: string,
  opcoes: { log: Logger; timeoutMs: number; orfaoMs: number },
): Promise<string> {
  const inicio = Date.now();
  let avisouEspera = false;

  for (;;) {
    try {
      return criarLock(dirLock);
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code !== 'EEXIST') throw erro;

      if (!avisouEspera) {
        opcoes.log({ nivel: 'debug', evento: 'lock-espera' });
        avisouEspera = true;
      }

      if (lockOrfao(dirLock, opcoes.orfaoMs)) {
        removerLock(dirLock);
        opcoes.log({ nivel: 'aviso', evento: 'lock-orfao-removido' });
        continue;
      }

      if (Date.now() - inicio > opcoes.timeoutMs) {
        throw new ErroHexlog('LOCK_TIMEOUT', `lock não liberado em ${opcoes.timeoutMs}ms`);
      }
      await esperarMs(LOCK_RETRY_MS);
    }
  }
}

function criarLock(dirLock: string): string {
  fs.mkdirSync(dirLock, 0o700);
  const token = `${process.pid}-${randomBytes(16).toString('hex')}`;
  fs.writeFileSync(path.join(dirLock, ARQUIVO_TOKEN), token, { mode: 0o600 });
  return token;
}

function lockOrfao(dirLock: string, orfaoMs: number): boolean {
  try {
    return Date.now() - fs.statSync(dirLock).mtimeMs > orfaoMs;
  } catch {
    return false; // sumiu entre o EEXIST e o stat: outro processo já resolveu
  }
}

function removerLock(dirLock: string): void {
  try {
    fs.rmSync(dirLock, { recursive: true, force: true });
  } catch {
    // já removido por outro processo
  }
}

function liberarLock(dirLock: string, token: string): void {
  if (lerToken(dirLock) !== token) return; // não é mais nosso: não mexe no lock de outro dono
  removerLock(dirLock);
}

function lerToken(dirLock: string): string | null {
  try {
    return fs.readFileSync(path.join(dirLock, ARQUIVO_TOKEN), 'utf8');
  } catch {
    return null;
  }
}

// Espera assíncrona (DE-29): fora da seção crítica, então não precisa bloquear a thread — libera
// o event loop para outras chamadas da mesma sessão MCP enquanto este pedido aguarda o retry.
function esperarMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
