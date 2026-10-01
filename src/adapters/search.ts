import { isPlainObject, orderBy } from 'es-toolkit';
import MiniSearch from 'minisearch';
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

/** Termos distintos da consulta depois do tokenizador padrão do MiniSearch e de `stripDiacritics`. */
function distinctTerms(text: string): number {
  const tokenize = MiniSearch.getDefault('tokenize') as (input: string) => string[];
  const terms = tokenize(text).map(stripDiacritics).filter(Boolean);
  return new Set(terms).size;
}

/**
 * Índice MiniSearch montado a cada chamada sobre `records`, sem cache: `AND` + prefixo + `fuzzy`
 * 0.1, com fallback para `OR` quando o `AND` não acha nada e a consulta tem 2+ termos distintos
 * (o `OR` exige que metade dos termos, arredondada para cima, case). Empate de relevância mantém
 * a ordem de `records`.
 */
export function createSearchIndex(): SearchIndex {
  return {
    search(records, text) {
      const engine = new MiniSearch<{ index: number; text: string }>({
        idField: 'index',
        fields: ['text'],
        processTerm: (term) => stripDiacritics(term) || null,
        searchOptions: { combineWith: 'AND', prefix: true, fuzzy: 0.1 },
      });
      engine.addAll(records.map((record, index) => ({ index, text: indexableText(record) })));

      let hits = engine.search(text);
      const terms = distinctTerms(text);
      if (hits.length === 0 && terms >= 2) {
        const floor = Math.ceil(terms / 2);
        hits = engine
          .search(text, { combineWith: 'OR' })
          .filter((hit) => new Set(hit.queryTerms).size >= floor);
      }

      return orderBy(hits, [(hit) => hit.score, (hit) => hit.id as number], ['desc', 'asc']).map(
        (hit) => records[hit.id as number]!.id,
      );
    },
  };
}
