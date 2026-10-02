import { isPlainObject, orderBy, sumBy } from 'es-toolkit';
import MiniSearch from 'minisearch';
import { sha256hex } from '../domain/chain.ts';
import type { Hash } from '../domain/ids.ts';
import type { HexRecord } from '../domain/record.ts';
import type { SearchIndex } from '../ports.ts';

const DIACRITICS_RE = /[̀-ͯ]/g;

/** Remove acentos e normaliza para minúsculas, no índice e na consulta. */
const stripDiacritics = (term: string): string =>
  term.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();

/** Todas as strings de um valor JSON, inclusive as aninhadas em objetos e listas. */
function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isPlainObject(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

/** Texto indexável de um registro: `type`, `target` e as strings de `data`; ids e relações ficam fora. */
function indexableText(record: HexRecord): string {
  return [record.type, record.target, ...collectStrings(record.data)].join('\n');
}

/**
 * Termos distintos da consulta depois do tokenizador padrão do MiniSearch e de `stripDiacritics`.
 * Termo repetido, inclusive só em outra caixa ou acento, entra uma vez: cada ocorrência custaria
 * uma busca completa por prefixo e `fuzzy`.
 */
function queryTerms(text: string): string[] {
  const tokenize = MiniSearch.getDefault('tokenize') as (input: string) => string[];
  return [...new Set(tokenize(text).map(stripDiacritics).filter(Boolean))];
}

type Engine = MiniSearch<{ index: number; text: string }>;

/** Índice de um processo; `count` e `lastHash` são a chave de validade contra o `records` seguinte. */
type Entry = { engine: Engine; count: number; lastHash: Hash };

/**
 * Orçamento de registros indexados, somados entre os processos em cache (~0,12 ms e ~4 KiB de
 * memória por registro, então ~7 s de montagem e ~250 MiB no teto). Um processo maior que isso
 * sozinho não é guardado.
 */
export const SEARCH_INDEX_BUDGET_RECORDS = 60_000;

/** Impressão do conteúdo do registro; o `HexRecord` não carrega o hash da cadeia. */
const fingerprintOf = (record: HexRecord): Hash => sha256hex(JSON.stringify(record));

const buildEngine = (): Engine =>
  new MiniSearch({
    idField: 'index',
    fields: ['text'],
    processTerm: (term) => stripDiacritics(term) || null,
    searchOptions: { combineWith: 'AND', prefix: true, fuzzy: 0.1 },
  });

/** Documentos de `records` a partir da posição `from`; o `index` é a posição em `records`. */
const toDocuments = (records: readonly HexRecord[], from: number) =>
  records.slice(from).map((record, offset) => ({
    index: from + offset,
    text: indexableText(record),
  }));

/**
 * Índice em cache ainda válido para `records`, já com os registros novos acrescentados; `undefined`
 * quando o log encolheu ou o registro na última posição indexada mudou (o log é append-only, então
 * isso só acontece com outro conteúdo sob a mesma chave).
 */
function reuseEngine(entry: Entry | undefined, records: readonly HexRecord[]): Engine | undefined {
  if (!entry || records.length < entry.count) return undefined;
  if (fingerprintOf(records[entry.count - 1]!) !== entry.lastHash) return undefined;
  if (records.length > entry.count) entry.engine.addAll(toDocuments(records, entry.count));
  return entry.engine;
}

/**
 * Índice MiniSearch cacheado por processo hexlog: `AND` + prefixo + `fuzzy` 0.1, com fallback para
 * `OR` quando o `AND` não acha nada e a consulta tem 2+ termos distintos (o `OR` exige que metade
 * dos termos, arredondada para cima, case). A consulta é deduplicada antes de buscar, então
 * repetir um termo não pesa mais na ordenação. Empate de relevância mantém a ordem de `records`.
 *
 * O cache vive no processo do servidor e é validado por quantidade de registros + impressão do
 * último: mesmo conjunto reaproveita o índice, log que só cresceu indexa só os registros novos e
 * qualquer divergência remonta. A soma dos registros em cache respeita `budget` (por padrão
 * `SEARCH_INDEX_BUDGET_RECORDS`): passou, sai o processo usado há mais tempo; processo maior que
 * o `budget` sozinho remonta a cada busca.
 */
export function createSearchIndex(budget = SEARCH_INDEX_BUDGET_RECORDS): SearchIndex {
  // A ordem de inserção do Map é a ordem de uso: cada busca reinsere a chave no fim.
  const entries = new Map<string, Entry>();

  function engineFor(key: string, records: readonly HexRecord[]): Engine {
    const cached = entries.get(key);
    entries.delete(key);
    let engine = reuseEngine(cached, records);
    if (!engine) {
      engine = buildEngine();
      engine.addAll(toDocuments(records, 0));
    }
    if (records.length > budget) return engine;

    entries.set(key, {
      engine,
      count: records.length,
      lastHash: fingerprintOf(records[records.length - 1]!),
    });
    let total = sumBy([...entries.values()], (entry) => entry.count);
    for (const [oldestKey, oldest] of entries) {
      if (total <= budget) break;
      entries.delete(oldestKey);
      total -= oldest.count;
    }
    return engine;
  }

  return {
    search(process, records, text) {
      if (records.length === 0) {
        entries.delete(`${process.project}/${process.process}`);
        return [];
      }
      const engine = engineFor(`${process.project}/${process.process}`, records);

      const terms = queryTerms(text);
      const query = terms.join(' ');
      let hits = engine.search(query);
      if (hits.length === 0 && terms.length >= 2) {
        const floor = Math.ceil(terms.length / 2);
        hits = engine
          .search(query, { combineWith: 'OR' })
          .filter((hit) => new Set(hit.queryTerms).size >= floor);
      }

      return orderBy(hits, [(hit) => hit.score, (hit) => hit.id as number], ['desc', 'asc']).map(
        (hit) => records[hit.id as number]!.id,
      );
    },
  };
}
