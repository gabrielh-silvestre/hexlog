import { isNil, isString, orderBy, round } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import MiniSearch from 'minisearch';
import { FULL_ID_RE, type EventLine } from './events.ts';

/** Teto de caracteres do parâmetro `search` de `events` (§4.16): abaixo de 2, `prefix` casaria quase tudo. */
export const SEARCH_MAX_CHARS = 200;

const DIACRITICS_RE = /[̀-ͯ]/g;
const HEX_PREFIX_RE = /^hex:/;

/** Remove acentos e normaliza para minúsculas (mesma função do probe da frente 15). */
export function stripDiacritics(t: string): string {
  return t.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();
}

/** Texto livre indexável de uma linha (§4.17): campos por tipo, concatenados com `\n`; ids e endereços ficam fora. */
export function indexableText(line: EventLine): string {
  if (line.type === 'milestone') {
    const data = line.data as { milestoneType?: string };
    return data.milestoneType === 'gate' ? gateText(line.data) : milestoneText(line.data);
  }
  if (line.type === 'verdict') return verdictText(line.data);
  return customText(line.data);
}

function milestoneText(data: Record<string, unknown>): string {
  const milestone = data as {
    milestoneType?: string;
    count?: { field?: string };
    decisions?: { item: string; action: string; text: string }[];
  };
  const decisions = (milestone.decisions ?? []).flatMap((decision) => [
    decision.item,
    decision.action,
    decision.text,
  ]);
  return [milestone.milestoneType, milestone.count?.field, ...decisions]
    .filter(isString)
    .join('\n');
}

function gateText(data: Record<string, unknown>): string {
  const gate = data as { gate?: { name?: string; criteria?: string; evidence?: unknown[] } };
  const evidenceItems = (gate.gate?.evidence ?? []).filter(isString);
  return [gate.gate?.name, gate.gate?.criteria, ...evidenceItems].filter(isString).join('\n');
}

function verdictText(data: Record<string, unknown>): string {
  const verdict = data as {
    claim?: string;
    source?: string;
    result?: string;
    evidence?: string | string[];
    origin?: string;
    trace?: string;
  };
  const evidence = isString(verdict.evidence)
    ? [verdict.evidence]
    : (verdict.evidence ?? []).filter(isString);
  return [verdict.claim, verdict.source, verdict.result, ...evidence, verdict.origin, verdict.trace]
    .filter(isString)
    .join('\n');
}

/** Tipo custom (§4.17): todo valor string em qualquer profundidade, exceto endereços `hex:` e ids completos. */
function customText(data: Record<string, unknown>): string {
  const parts: string[] = [];
  collectStrings(data, parts);
  return parts.join('\n');
}

function collectStrings(value: unknown, parts: string[]): void {
  if (isString(value)) {
    if (!HEX_PREFIX_RE.test(value) && !FULL_ID_RE.test(value)) parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, parts));
    return;
  }
  if (!isNil(value) && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, parts));
  }
}

/**
 * Filters estruturados de `events` (§4.12 item 9): igualdade exata sobre `data` cru, nunca via
 * índice de texto. `after`/`before` já normalizados (`new Date(v).toISOString()`) por quem chama.
 */
export type Filters = {
  type?: string;
  target?: string;
  milestoneType?: string;
  result?: string;
  after?: string;
  before?: string;
};

/** Uma linha é candidata quando satisfaz todos os filtros presentes (§4.12 item 9). */
export function isCandidate(line: EventLine, filters: Filters): boolean {
  if (!isNil(filters.type) && line.type !== filters.type) return false;
  if (!isNil(filters.target) && !matchesTarget(line, filters.target)) return false;
  if (!isNil(filters.milestoneType) && !matchesMilestoneType(line, filters.milestoneType))
    return false;
  if (!isNil(filters.result) && !matchesResult(line, filters.result)) return false;
  if (!isNil(filters.after) && line.timestamp < filters.after) return false;
  if (!isNil(filters.before) && line.timestamp >= filters.before) return false;
  return true;
}

function matchesTarget(line: EventLine, target: string): boolean {
  return (line.data as { target?: string }).target === target;
}

function matchesMilestoneType(line: EventLine, milestoneType: string): boolean {
  return (
    line.type === 'milestone' &&
    (line.data as { milestoneType?: string }).milestoneType === milestoneType
  );
}

function matchesResult(line: EventLine, result: string): boolean {
  return line.type === 'verdict' && (line.data as { result?: string }).result === result;
}

/** Quantidade de termos distintos de `search` depois de tokenizar (padrão do MiniSearch) e aplicar `processTerm`. */
export function distinctTerms(search: string): number {
  const tokenize = MiniSearch.getDefault('tokenize') as (text: string) => string[];
  const terms = tokenize(search)
    .map(stripDiacritics)
    .filter((term) => term.length > 0);
  return new Set(terms).size;
}

type Candidate = { index: number; line: EventLine };
type SearchResult = { index: number; relevance: number };

/**
 * Índice MiniSearch (§4.17), construído só sobre `candidates`, a cada chamada: config fixa
 * `AND` + `prefix` + `fuzzy: 0.1`, com fallback para `OR` quando o `AND` não devolve nada e a
 * consulta tem 2+ termos distintos.
 */
export function search(
  candidates: Candidate[],
  query: string,
): { results: SearchResult[]; combination: 'AND' | 'OR' } {
  const engine = new MiniSearch<{ index: number; text: string }>({
    idField: 'index',
    fields: ['text'],
    processTerm: (t) => stripDiacritics(t) || null,
    searchOptions: { combineWith: 'AND', prefix: true, fuzzy: 0.1 },
  });
  engine.addAll(candidates.map((c) => ({ index: c.index, text: indexableText(c.line) })));

  let raw = engine.search(query);
  let combination: 'AND' | 'OR' = 'AND';
  if (isEmpty(raw) && distinctTerms(query) >= 2) {
    raw = engine.search(query, { combineWith: 'OR' });
    combination = 'OR';
  }

  const results = raw.map((r) => ({ index: r.id as number, relevance: round(r.score, 4) }));
  return { results: orderBy(results, ['relevance', 'index'], ['desc', 'asc']), combination };
}
