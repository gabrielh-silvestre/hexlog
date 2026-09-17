import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { isNil } from 'es-toolkit';
import { omit } from 'es-toolkit/compat';
import type { Detail } from './errors.ts';
import { EventLine } from './events.ts';

type BreakReason = 'invalid-line' | 'diverging-seq' | 'hash-mismatch' | 'invalid-data';

export type Break = { index: number; reason: BreakReason };

export type Chain = {
  ok: boolean;
  totalLines: number;
  head: string;
  breaks: Break[];
  totalBreaks: number;
  repairedLines: number[];
};

const MAX_BREAKS = 100;
const MAX_REPAIRED = 100;

export function sha256hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `hashLine(l) = sha256hex(l.prevHash + canonicalize(omit(l, 'prevHash')))` (JCS, §4.6). */
export function hashLine(l: EventLine): string {
  return sha256hex(l.prevHash + jcs(omit(l, ['prevHash'])));
}

/** `anchor(manifest) = sha256hex(canonicalize(manifest))`: raiz da cadeia de um processo. */
export function anchor(manifest: unknown): string {
  return sha256hex(jcs(manifest));
}

// canonicalize devolve `string | undefined` só para entradas não serializáveis (function,
// symbol, undefined); EventLine e o manifesto nunca são isso, mas o tipo exige o fallback.
function jcs(value: unknown): string {
  return canonicalize(value) ?? '';
}

/** Predicado único (escritor e verificador): a linha é um elo válido, ou `null`. */
export function isValidLink(text: string): EventLine | null {
  try {
    const result = EventLine.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** `prevHash` esperado do próximo elo, dado o último elo válido anterior (ou `null` = início da cadeia). */
export function expectedPrevHash(lastLink: EventLine | null, manifest: unknown): string {
  return isNil(lastLink) ? anchor(manifest) : hashLine(lastLink);
}

/** `seq` esperado do próximo elo: `n` = linhas não-elo (pendentes) desde o último elo (ou desde o início). */
export function nextSeq(lastLink: EventLine | null, n: number): number {
  return isNil(lastLink) ? n : lastLink.seq + 1 + n;
}

/**
 * Verifica a cadeia de hash de um log JSONL (§4.6). `validateData`, quando informado, roda
 * sobre `{type, data}` de cada elo e retorna `Detail[]` (reprovado) ou `null` (aprovado);
 * um retorno não nulo vira quebra `invalid-data`.
 */
export function verifyChain(
  text: string,
  manifest: unknown,
  validateData?: (type: string, data: Record<string, unknown>) => Detail[] | null,
): Chain {
  // A cauda sem '\n' (escrita em andamento, ou rasgo ainda não reparado) é ignorada:
  // split(-1) descarta o último elemento, terminado ou não.
  const lines = text.split('\n').slice(0, -1);

  let lastLink: EventLine | null = null;
  let pending: number[] = [];
  const breaks: Break[] = [];
  const repairedLines: number[] = [];

  const resolvePending = (repair: boolean) => {
    if (repair) {
      repairedLines.push(...pending);
    } else {
      for (const index of pending) breaks.push({ index, reason: 'invalid-line' });
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
    if (!seqOk) breaks.push({ index, reason: 'diverging-seq' });
    if (!hashOk) breaks.push({ index, reason: 'hash-mismatch' });
    resolvePending(seqOk && hashOk);

    if (!isNil(validateData) && !isNil(validateData(link.type, link.data))) {
      breaks.push({ index, reason: 'invalid-data' });
    }

    lastLink = link;
  });
  resolvePending(false);

  breaks.sort((a, b) => a.index - b.index);

  return {
    ok: breaks.length === 0,
    totalLines: lines.length,
    head: isNil(lastLink) ? '' : hashLine(lastLink),
    breaks: breaks.slice(0, MAX_BREAKS),
    totalBreaks: breaks.length,
    repairedLines: repairedLines.slice(0, MAX_REPAIRED),
  };
}
