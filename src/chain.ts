import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { isNil } from 'es-toolkit';
import { omit } from 'es-toolkit/compat';
import type { Detail } from './errors.ts';
import { Linha } from './events.ts';

type MotivoQuebra = 'linha-invalida' | 'seq-divergente' | 'hash-nao-bate' | 'dados-invalidos';

export type Quebra = { indice: number; motivo: MotivoQuebra };

export type Chain = {
  ok: boolean;
  totalLinhas: number;
  cabeca: string;
  quebras: Quebra[];
  totalQuebras: number;
  linhasReparadas: number[];
};

const TETO_QUEBRAS = 100;
const TETO_REPARADAS = 100;

export function sha256hex(texto: string): string {
  return createHash('sha256').update(texto).digest('hex');
}

/** `hashLine(l) = sha256hex(l.prevHash + canonicalize(omit(l, 'prevHash')))` (JCS, §4.6). */
export function hashLine(l: Linha): string {
  return sha256hex(l.prevHash + jcs(omit(l, ['prevHash'])));
}

/** `anchor(manifest) = sha256hex(canonicalize(manifest))`: raiz da cadeia de um processo. */
export function anchor(manifest: unknown): string {
  return sha256hex(jcs(manifest));
}

// canonicalize devolve `string | undefined` só para entradas não serializáveis (function,
// symbol, undefined); Linha e o manifesto nunca são isso, mas o tipo exige o fallback.
function jcs(value: unknown): string {
  return canonicalize(value) ?? '';
}

/** Predicado único (escritor e verificador): a linha é um elo válido, ou `null`. */
export function isValidLink(text: string): Linha | null {
  try {
    const result = Linha.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** `prevHash` esperado do próximo elo, dado o último elo válido anterior (ou `null` = início da cadeia). */
export function expectedPrevHash(lastLink: Linha | null, manifest: unknown): string {
  return isNil(lastLink) ? anchor(manifest) : hashLine(lastLink);
}

/** `seq` esperado do próximo elo: `n` = linhas não-elo (pendentes) desde o último elo (ou desde o início). */
export function nextSeq(lastLink: Linha | null, n: number): number {
  return isNil(lastLink) ? n : lastLink.seq + 1 + n;
}

/**
 * Verifica a cadeia de hash de um log JSONL (§4.6). `validateData`, quando informado, roda
 * sobre `{tipo, dados}` de cada elo e retorna `Detail[]` (reprovado) ou `null` (aprovado);
 * um retorno não nulo vira quebra `dados-invalidos`.
 */
export function verifyChain(
  texto: string,
  manifest: unknown,
  validateData?: (tipo: string, dados: Record<string, unknown>) => Detail[] | null,
): Chain {
  // A cauda sem '\n' (escrita em andamento, ou rasgo ainda não reparado) é ignorada:
  // split(-1) descarta o último elemento, terminado ou não.
  const lines = texto.split('\n').slice(0, -1);

  let lastLink: Linha | null = null;
  let pending: number[] = [];
  const quebras: Quebra[] = [];
  const linhasReparadas: number[] = [];

  const resolvePending = (repair: boolean) => {
    if (repair) {
      linhasReparadas.push(...pending);
    } else {
      for (const index of pending) quebras.push({ indice: index, motivo: 'linha-invalida' });
    }
    pending = [];
  };

  lines.forEach((line, index) => {
    const link = isValidLink(line);
    if (isNil(link)) {
      pending.push(index);
      return;
    }

    const seqOk = link.seq === nextSeq(lastLink, pending.length);
    const hashOk = link.prevHash === expectedPrevHash(lastLink, manifest);
    if (!seqOk) quebras.push({ indice: index, motivo: 'seq-divergente' });
    if (!hashOk) quebras.push({ indice: index, motivo: 'hash-nao-bate' });
    resolvePending(seqOk && hashOk);

    if (!isNil(validateData) && !isNil(validateData(link.tipo, link.dados))) {
      quebras.push({ indice: index, motivo: 'dados-invalidos' });
    }

    lastLink = link;
  });
  resolvePending(false);

  quebras.sort((a, b) => a.indice - b.indice);

  return {
    ok: quebras.length === 0,
    totalLinhas: lines.length,
    cabeca: isNil(lastLink) ? '' : hashLine(lastLink),
    quebras: quebras.slice(0, TETO_QUEBRAS),
    totalQuebras: quebras.length,
    linhasReparadas: linhasReparadas.slice(0, TETO_REPARADAS),
  };
}
