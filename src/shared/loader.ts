import { isUndefined } from 'es-toolkit';
import { z } from 'zod';
import {
  anchor,
  hashLink,
  isValidLink,
  Link,
  type Expected,
  type LinkRejection,
} from '../domain/chain.ts';
import type { Hash, RecordId } from '../domain/ids.ts';
import type { Manifest } from '../domain/manifest.ts';
import { BATCH_MAX } from '../domain/record.ts';
import { HexlogError } from '../errors.ts';
import type { ProcessReader, ProcessRef, RawProcess } from '../ports.ts';

// Tetos de saída da verificação de cadeia, como no 0.x.
export const MAX_BREAKS = 100;
const MAX_REPAIRED = 100;

/**
 * Elo quebrado: `index` é a posição da linha no arquivo, contada a partir de 0. `head-not-found`
 * vem de `checkExpectedHead` e leva `totalRecords` no lugar da posição, porque o elo que falta
 * não está no arquivo.
 */
export type Break = { index: number; reason: LinkRejection | 'head-not-found' };

/** Resultado da verificação da cadeia de um processo (`verify_chain`). */
export type Chain = {
  ok: boolean;
  totalRecords: number;
  /** Hash do último elo contado; sem elo contado, a âncora do processo (o hash do manifesto). */
  head: string;
  breaks: Break[];
  totalBreaks: number;
  repairedLines: number[];
};

/** D-04: a linha do log é `{ links: [Link…] }`, de 1 a `BATCH_MAX` elos; o conteúdo de cada um é validado por `isValidLink`. */
const LineShape = z.strictObject({ links: z.array(z.unknown()).min(1).max(BATCH_MAX) });

/** Posição esperada do elo seguinte a `link`. */
function after(link: Link): Expected {
  return { seq: link.seq + 1, prevHash: hashLink(link) };
}

/** D-05: linha completa e válida, rasgada (nem JSON) ou rejeitada (JSON que não ocupa a posição). */
export type LineCheck =
  | { status: 'valid'; links: Link[]; next: Expected }
  | { status: 'torn' }
  // `next` só existe quando todos os elos têm forma de `Link`: a cadeia segue dali, como em 0.x.
  | { status: 'rejected'; reasons: LinkRejection[]; next?: Expected };

function checkLinks(values: readonly unknown[], start: Expected): LineCheck {
  const links: Link[] = [];
  const reasons = new Set<LinkRejection>();
  let expected = start;
  for (const value of values) {
    const check = isValidLink(value, expected);
    if ('reasons' in check) {
      if (check.reasons.includes('invalid-line')) {
        return { status: 'rejected', reasons: [...reasons, 'invalid-line'] };
      }
      check.reasons.forEach((reason) => reasons.add(reason));
    }
    // Invariante: sem `invalid-line` em `reasons`, o valor passou em `parseLink`; o parse repete esse
    // resultado, e só no caminho de quebra.
    const link = 'link' in check ? check.link : Link.parse(value);
    links.push(link);
    expected = after(link);
  }
  if (reasons.size > 0) return { status: 'rejected', reasons: [...reasons], next: expected };
  return { status: 'valid', links, next: expected };
}

/**
 * D-05, o predicado único de leitura e escrita: `segment` parseia como `{ links }`, cada elo passa
 * por `isValidLink`, o primeiro ocupa `expected` e os seguintes continuam o hash e o `seq` do
 * anterior. O único `JSON.parse` da linha mora aqui (SL2).
 */
export function isValidLine(segment: string, expected: Expected): LineCheck {
  let value: unknown;
  try {
    value = JSON.parse(segment);
  } catch {
    return { status: 'torn' };
  }
  const line = LineShape.safeParse(value);
  if (!line.success) return { status: 'rejected', reasons: ['invalid-line'] };
  return checkLinks(line.data.links, expected);
}

/** D-05: o enquadramento `{ links }` + `\n` tem um dono só; `decide` chama esta função. */
export function formatLine(links: readonly Link[]): string {
  return `${JSON.stringify({ links })}\n`;
}

/** Linha que entrou no log, com a posição dela no arquivo. */
export type ParsedLine = { index: number; links: Link[] };

export type ParsedLog = {
  lines: ParsedLine[];
  breaks: Break[];
  /** Linhas rasgadas seguidas de uma linha válida: aparecem no `verify_chain` e não quebram. */
  repairedLines: number[];
  /** Posição do próximo elo, depois da última linha que a cadeia contou. */
  end: Expected;
};

/**
 * D-05: aplica `isValidLine` a cada segmento separado por `\n`, em ordem, com uma sequência
 * pendente de linhas rasgadas. O último segmento (sem `\n`) segue a mesma regra das linhas
 * completas: entra se `isValidLine` o aceita, e rasgado ou vazio cai na pendente, que sem linha
 * válida depois é ignorada (não consome `seq`, não é quebra).
 */
export function parseLog(text: string, anchorHash: Hash): ParsedLog {
  const lines: ParsedLine[] = [];
  const breaks: Break[] = [];
  const repairedLines: number[] = [];
  let pending: number[] = [];
  let expected: Expected = { seq: 0, prevHash: anchorHash };

  for (const [index, segment] of text.split('\n').entries()) {
    const check = isValidLine(segment, expected);
    if (check.status === 'torn') {
      pending.push(index);
      continue;
    }
    if (check.status === 'valid') {
      pending.forEach((torn) => repairedLines.push(torn));
      lines.push({ index, links: check.links });
    } else {
      pending.forEach((torn) => breaks.push({ index: torn, reason: 'invalid-line' }));
      check.reasons.forEach((reason) => breaks.push({ index, reason }));
    }
    pending = [];
    expected = check.next ?? expected;
  }
  return { lines, breaks, repairedLines, end: expected };
}

/** Lote que já entrou no log: a impressão dele e os elos da linha (D-06). */
export type BatchEntry = { fingerprint: Hash; links: Link[] };

export type VerifiedProcess = {
  manifest: Manifest;
  records: Link[];
  chain: Chain;
  /** Lotes por `key`; a primeira ocorrência vale. */
  batches: Map<string, BatchEntry>;
  /** Posição do próximo elo: `seq` e `prevHash` que a gravação seguinte precisa usar. */
  end: Expected;
};

/** O que sobra do log depois do corte no marcador. */
type View = {
  /** Linhas inteiras que ficam. */
  lines: ParsedLine[];
  /** Elos de uma linha cortada no meio pelo marcador. */
  partial: Link[];
  /** Quebras e linhas reparadas só contam abaixo deste índice de linha. */
  limit: number;
  end: Expected;
};

function cutAtMarker(parsed: ParsedLog, marker: RecordId | null, start: Expected): View {
  if (marker === null) return { lines: [], partial: [], limit: 0, end: start };
  for (const [at, line] of parsed.lines.entries()) {
    const position = line.links.findIndex((link) => link.id === marker);
    if (position === -1) continue;
    const whole = position === line.links.length - 1;
    const partial = whole ? [] : line.links.slice(0, position + 1);
    const lines = parsed.lines.slice(0, whole ? at + 1 : at);
    const last = partial.at(-1) ?? lines.at(-1)?.links.at(-1);
    return {
      lines,
      partial,
      limit: line.index + 1,
      end: isUndefined(last) ? start : after(last),
    };
  }
  const message = 'marker record not found in process';
  throw new HexlogError('MARKER_NOT_FOUND', message, [
    { path: '/marker', code: 'marker-not-found', message },
  ]);
}

function indexBatches(lines: readonly ParsedLine[]): Map<string, BatchEntry> {
  const batches = new Map<string, BatchEntry>();
  for (const { links } of lines) {
    const [first] = links;
    const batch = first?.batch;
    if (isUndefined(batch?.key) || batches.has(batch.key)) continue;
    batches.set(batch.key, { fingerprint: batch.fingerprint, links });
  }
  return batches;
}

/**
 * Puro: `parseLog` uma vez sobre o log cru (SL2), e com `marker` corta no registro marcado
 * (`null` lê o processo como vazio; id ausente dá `MARKER_NOT_FOUND`). A cadeia devolvida só
 * conta o que fica antes do corte.
 */
export function verifyProcess(raw: RawProcess, marker?: RecordId | null): VerifiedProcess {
  const start: Expected = { seq: 0, prevHash: anchor(raw.manifest) };
  const parsed = parseLog(raw.text, start.prevHash);
  const view: View = isUndefined(marker)
    ? { lines: parsed.lines, partial: [], limit: Infinity, end: parsed.end }
    : cutAtMarker(parsed, marker, start);

  const records = view.lines.flatMap((line) => line.links).concat(view.partial);
  const breaks = parsed.breaks.filter(({ index }) => index < view.limit);
  const repairedLines = parsed.repairedLines.filter((index) => index < view.limit);
  return {
    manifest: raw.manifest,
    records,
    chain: {
      ok: breaks.length === 0,
      totalRecords: records.length,
      head: view.end.prevHash,
      breaks: breaks.slice(0, MAX_BREAKS),
      totalBreaks: breaks.length,
      repairedLines: repairedLines.slice(0, MAX_REPAIRED),
    },
    batches: indexBatches(view.lines),
    end: view.end,
  };
}

/**
 * Head guardado contra truncamento: `expectedHead` (o `head` de uma verificação anterior) tem de
 * ser o hash de algum elo válido, o último ou um anterior, porque o log pode ter crescido depois,
 * ou a âncora do processo (hash do manifesto), que precede todo elo e é o `head` de um log vazio.
 * Fora disso a cadeia ganha a quebra `head-not-found` (cauda apagada ou reescrita). A quebra
 * respeita o teto `MAX_BREAKS` na lista e conta sempre em `totalBreaks`.
 */
export function checkExpectedHead(
  { chain, records, manifest }: Pick<VerifiedProcess, 'chain' | 'records' | 'manifest'>,
  expectedHead: Hash,
): Chain {
  // O head da própria verificação fecha sem re-hashear o log e vale mesmo com quebra no meio, onde
  // `chain.head` pode ser de uma linha rejeitada que não está em `records`.
  // ponytail: o `some` re-hasheia todos os elos quando o head não é o último; o teto de 64 MiB do
  // log (`MAX_LOG_BYTES`) limita essa segunda passada, e expor os hashes do `parseLog` a evitaria.
  if (
    expectedHead === chain.head ||
    expectedHead === anchor(manifest) ||
    records.some((link) => hashLink(link) === expectedHead)
  ) {
    return chain;
  }
  const missing: Break = { index: chain.totalRecords, reason: 'head-not-found' };
  return {
    ...chain,
    ok: false,
    breaks: chain.breaks.length < MAX_BREAKS ? [...chain.breaks, missing] : chain.breaks,
    totalBreaks: chain.totalBreaks + 1,
  };
}

/** `verifyProcess` sobre a leitura crua de `store`: o único carregador de processo da árvore nova. */
export function loadVerified(
  store: ProcessReader,
  ref: ProcessRef,
  marker?: RecordId | null,
): VerifiedProcess {
  return verifyProcess(store.read(ref), marker);
}
