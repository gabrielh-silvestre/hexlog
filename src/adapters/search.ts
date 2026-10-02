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

/**
 * Termos distintos da consulta depois do tokenizador padrão do MiniSearch e de `stripDiacritics`.
 * Termo repetido, inclusive só em outra caixa ou acento, entra uma vez: cada ocorrência custaria
 * uma busca completa por prefixo e `fuzzy`.
 */
function queryTerms(text: string): string[] {
  const tokenize = MiniSearch.getDefault('tokenize') as (input: string) => string[];
  return [...new Set(tokenize(text).map(stripDiacritics).filter(Boolean))];
}

/**
 * Índice MiniSearch montado a cada chamada sobre `records`, sem cache: `AND` + prefixo + `fuzzy`
 * 0.1, com fallback para `OR` quando o `AND` não acha nada e a consulta tem 2+ termos distintos
 * (o `OR` exige que metade dos termos, arredondada para cima, case). A consulta é deduplicada
 * antes de buscar, então repetir um termo não pesa mais na ordenação. Empate de relevância mantém
 * a ordem de `records`.
 */
export function createSearchIndex(): SearchIndex {
  return {
    search(records, text) {
      // ponytail: o índice é remontado a cada chamada, ~0,12 ms por registro; no teto de 64 MiB
      // do log (~55 mil registros) são ~6-7 s síncronos por busca, e cada sessão/servidor MCP
      // paga o próprio índice (~42 MiB por 10.000 registros). Melhoria decidida, para a F4:
      // índice em memória por processo hexlog, com chave = quantidade de registros + hash do
      // último registro, `add` incremental (o log é append-only), teto ou LRU de memória, porta
      // `SearchIndex` com chave de processo e emenda do ADR 0008 sobre o "sem cache".
      const engine = new MiniSearch<{ index: number; text: string }>({
        idField: 'index',
        fields: ['text'],
        processTerm: (term) => stripDiacritics(term) || null,
        searchOptions: { combineWith: 'AND', prefix: true, fuzzy: 0.1 },
      });
      engine.addAll(records.map((record, index) => ({ index, text: indexableText(record) })));

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
