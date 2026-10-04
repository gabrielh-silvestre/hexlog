import { isPlainObject, orderBy, sumBy } from 'es-toolkit';
import MiniSearch from 'minisearch';
import { sha256hex } from '../domain/chain.ts';
import type { Hash } from '../domain/ids.ts';
import type { HexRecord } from '../domain/record.ts';
import { PROJECT_INDEX, type SearchIndex } from '../ports.ts';

const DIACRITICS_RE = /[\u0300-\u036f]/g;

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

type Engine = MiniSearch<{ id: number; text: string }>;

/** Índice de um processo com o que o orçamento mede (`chars`); `count` e `lastHash` são a chave de validade. */
type Built = { engine: Engine; chars: number };
type Entry = Built & { count: number; lastHash: Hash };

/**
 * Orçamento de texto indexado, em caracteres de `indexableText` somados entre os processos em
 * cache. O MiniSearch retém 8,7 a 12,4 B por caractere nos logs reais (registro típico de ~840
 * caracteres: 7 a 10 KiB e ~0,25 ms), então ~24M caracteres são ~250 MiB retidos. Contar registros
 * não limitaria a memória: o custo escala com o texto. Um processo maior que isso sozinho não é
 * guardado, e a montagem a frio acima do teto é aceita (~0,3 µs por caractere, ~7 s síncronos em
 * 24M), igual a cada busca.
 */
export const SEARCH_INDEX_BUDGET_CHARS = 24_000_000;

/** Impressão do conteúdo do registro; o `HexRecord` não carrega o hash da cadeia. */
const fingerprintOf = (record: HexRecord): Hash => sha256hex(JSON.stringify(record));

const buildEngine = (): Engine =>
  new MiniSearch({
    fields: ['text'],
    processTerm: (term) => stripDiacritics(term) || null,
    searchOptions: { combineWith: 'AND', prefix: true, fuzzy: 0.1 },
  });

/** Documentos de `records` a partir da posição `from`; o `id` é a posição em `records`. */
const toDocuments = (records: readonly HexRecord[], from: number) =>
  records.slice(from).map((record, offset) => ({
    id: from + offset,
    text: indexableText(record),
  }));

const charsOf = (documents: readonly { text: string }[]): number =>
  sumBy(documents, (document) => document.text.length);

function buildFrom(records: readonly HexRecord[]): Built {
  const documents = toDocuments(records, 0);
  const engine = buildEngine();
  engine.addAll(documents);
  return { engine, chars: charsOf(documents) };
}

/**
 * Índice em cache ainda válido para `records`, já com os registros novos acrescentados; `undefined`
 * quando o log encolheu ou o registro na última posição indexada mudou (o log é append-only, então
 * isso só acontece com outro conteúdo sob a mesma chave).
 */
function reuse(entry: Entry | undefined, records: readonly HexRecord[]): Built | undefined {
  if (!entry || records.length < entry.count) return undefined;
  if (fingerprintOf(records[entry.count - 1]!) !== entry.lastHash) return undefined;
  if (records.length === entry.count) return entry;
  const added = toDocuments(records, entry.count);
  entry.engine.addAll(added);
  return { engine: entry.engine, chars: entry.chars + charsOf(added) };
}

/**
 * Índice MiniSearch cacheado por processo hexlog: `AND` + prefixo + `fuzzy` 0.1 (fração do
 * comprimento do termo: um termo de 5 caracteres tolera 1 edição, um de 4 nenhuma), com fallback para
 * `OR` quando o `AND` não acha nada e a consulta tem 2+ termos distintos (o `OR` exige que metade
 * dos termos, arredondada para cima, case). A consulta é deduplicada antes de buscar, então
 * repetir um termo não pesa mais na ordenação. Empate de relevância mantém a ordem de `records`.
 *
 * `allowed` (D-20: o conjunto que passa nos filtros) entra como `filter` do MiniSearch nas duas
 * buscas, `AND` e `OR`, depois do score e antes de decidir o fallback e o piso: o `OR` roda quando
 * nenhum registro permitido casa todos os termos, como no 0.x. O índice, porém, é o do log
 * inteiro, então o IDF (a relevância) vem do log inteiro; isso muda só a ordem de relevância,
 * estável sob marcador, filtros e `text` fixos, nunca o conjunto devolvido.
 *
 * O cache vive no processo do servidor e é validado por quantidade de registros + impressão do
 * último: mesmo conjunto reaproveita o índice, log que só cresceu indexa só os registros novos e
 * qualquer divergência remonta. A soma dos caracteres indexados em cache respeita `budget` (por
 * padrão `SEARCH_INDEX_BUDGET_CHARS`): passou, sai o processo usado há mais tempo; processo maior
 * que o `budget` sozinho remonta a cada busca. O alcance projeto (`PROJECT_INDEX`) nunca é
 * guardado: cada registro já está no índice do seu processo, então guardá-lo contaria em
 * duplicidade e despejaria os processos quentes; ele monta um motor efêmero a cada busca.
 *
 * `addAll` do MiniSearch não é atômico e lança `duplicate ID` se o `id` já está no índice: se
 * lançar no meio, os documentos anteriores ficam indexados. Por isso `engineFor` apaga a entrada do
 * cache antes de `reuse`: um índice que falhou nunca volta ao cache meio atualizado, e a próxima
 * busca o remonta do zero.
 */
export function createSearchIndex(budget = SEARCH_INDEX_BUDGET_CHARS): SearchIndex {
  // A ordem de inserção do Map é a ordem de uso: cada busca reinsere a chave no fim.
  const entries = new Map<string, Entry>();

  function engineFor(key: string, records: readonly HexRecord[]): Engine {
    const cached = entries.get(key);
    entries.delete(key);
    const built = reuse(cached, records) ?? buildFrom(records);
    if (built.chars > budget) return built.engine;

    entries.set(key, {
      ...built,
      count: records.length,
      lastHash: fingerprintOf(records[records.length - 1]!),
    });
    let total = sumBy([...entries.values()], (entry) => entry.chars);
    for (const [oldestKey, oldest] of entries) {
      if (total <= budget) break;
      entries.delete(oldestKey);
      total -= oldest.chars;
    }
    return built.engine;
  }

  return {
    search(process, records, text, allowed) {
      const key = `${process.project}/${process.process}`;
      if (records.length === 0) {
        entries.delete(key);
        return [];
      }
      const engine =
        process.process === PROJECT_INDEX ? buildFrom(records).engine : engineFor(key, records);

      const filter =
        allowed === undefined
          ? undefined
          : (hit: { id: unknown }) => allowed.has(records[hit.id as number]!.id);
      const terms = queryTerms(text);
      const query = terms.join(' ');
      let hits = engine.search(query, { filter });
      if (hits.length === 0 && terms.length >= 2) {
        const floor = Math.ceil(terms.length / 2);
        hits = engine
          .search(query, { combineWith: 'OR', filter })
          .filter((hit) => new Set(hit.queryTerms).size >= floor);
      }

      return orderBy(hits, [(hit) => hit.score, (hit) => hit.id as number], ['desc', 'asc']).map(
        (hit) => records[hit.id as number]!.id,
      );
    },
  };
}
