import { isPlainObject, isUndefined } from 'es-toolkit';
import { pointer as jsonPointer } from '../errors.ts';
import type { RecordType } from './definitions.ts';

/** Palavras-chave de regex livre: o hexlog não as aplica nem as mostra (ver `withoutFreePatterns`). */
export const FREE_PATTERN_KEYWORDS = ['pattern', 'patternProperties'];

const SUBSCHEMA_KEYWORDS = [
  'additionalProperties',
  'items',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
];
const SUBSCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SUBSCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies', // legada, mas o ajv 2020 estrito a aceita e aplica
];

/** Só guardam definições: contam pelo `$ref` que as cita, não pela presença (ver `expandedSize`). */
const DEFINITION_KEYWORDS = ['$defs', 'definitions'];

type Subschema = Record<string, unknown>;

/**
 * Percorre só as palavras-chave que carregam subschemas (nunca `const`/`enum`/`default`/`examples`,
 * que são dado) e chama `visit(nó, ponteiro RFC 6901)` em cada objeto. O `visit` roda antes de as
 * palavras-chave de filho serem lidas: o que ele apagar do nó não é percorrido. Valor que não é
 * objeto (a forma de array de `dependencies`) é ignorado.
 */
export function walkSubschemas(root: unknown, visit: (node: Subschema, pointer: string) => void) {
  const walk = (node: unknown, pointer: string): void => {
    if (!isPlainObject(node)) return;
    visit(node, pointer);

    for (const key of SUBSCHEMA_KEYWORDS) walk(node[key], `${pointer}/${key}`);
    for (const key of SUBSCHEMA_LIST_KEYWORDS) {
      const list: unknown = node[key];
      if (Array.isArray(list)) list.forEach((item, i) => walk(item, `${pointer}/${key}/${i}`));
    }
    for (const key of SUBSCHEMA_MAP_KEYWORDS) {
      const map: unknown = node[key];
      if (!isPlainObject(map)) continue;
      for (const [name, child] of Object.entries(map))
        walk(child, `${pointer}/${key}${jsonPointer([name])}`);
    }
  };

  walk(root, '');
}

/**
 * Cópia do schema sem `pattern` e `patternProperties` em cada subschema; o campo de nome `pattern`
 * dentro de `properties` fica. Nunca muta a entrada: o manifesto lido (e o hash dele) não muda.
 */
export function withoutFreePatterns(schema: RecordType): RecordType {
  const clone = structuredClone(schema);
  walkSubschemas(clone, (node) => {
    for (const keyword of FREE_PATTERN_KEYWORDS) delete node[keyword];
  });
  return clone;
}

/**
 * Confere que o ponteiro RFC 6901 `location` resolve em `schema` num objeto que tem `keyword`.
 * Serve para o `path` só apontar o que existe no documento do agente.
 */
export function hasKeywordAt(schema: unknown, location: string, keyword: string): boolean {
  const node = valueAt(schema, location);
  return isPlainObject(node) && Object.hasOwn(node, keyword);
}

/** O que o ponteiro RFC 6901 `location` alcança em `schema`; `undefined` quando não resolve. */
function valueAt(schema: unknown, location: string): unknown {
  const segments = location === '' ? [] : location.split('/').slice(1);
  let node = schema;
  for (const raw of segments) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, segment))
      return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Teto das contagens abaixo: a soma satura aqui em vez de crescer sem limite. */
export const SATURATED = Number.MAX_SAFE_INTEGER;

/**
 * Palavras-chave que aplicam o subschema a um valor filho do dado (um nível abaixo). As outras
 * (composição, `not`, `if`/`then`/`else`, `dependentSchemas`, `dependencies` e `contentSchema`)
 * aplicam-se à mesma instância e ficam no mesmo nível. Na dúvida a palavra-chave não desce: o erro
 * superestima o custo, o lado seguro.
 */
const DESCENDING_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'items',
  'prefixItems',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/**
 * Tamanho expandido do schema: quantos subschemas uma validação pode visitar num valor só, contando
 * cada `$ref` pelo tamanho do destino (`$defs` só entra por quem o cita). Memoiza o destino de cada
 * `$ref` que não passa por ciclo, então o custo é linear no documento mesmo quando as referências
 * dobram a cada nível. `$ref` que não é ponteiro local (`#` ou `#/...`), `$dynamicRef` e `$id` em
 * subschema que não é a raiz valem `SATURATED`: sem como medir aqui, assume-se o pior.
 *
 * Sem `unfold`, o ciclo também vale `SATURATED`. Com `unfold`, o ciclo se desdobra até a
 * profundidade do dado (`depth`, os níveis de dado abaixo do nó): cada palavra-chave de
 * `DESCENDING_KEYWORDS` gasta um nível, e a citação de um `$ref` já em curso vale 0 quando o nível
 * ficou abaixo de 0. O ciclo que volta ao mesmo `$ref` sem gastar nível, o `budget` (subschemas
 * visitados) vencido e a pilha estourada valem `SATURATED`.
 */
export function expandedSize(root: unknown, unfold?: { depth: number; budget: number }): number {
  const refSizes = new Map<string, number>();
  // Os `$ref` em curso, com o nível em que foram citados; a raiz entra como `#`.
  const inProgress = [{ ref: '#', depth: unfold?.depth ?? 0 }];
  const budget = unfold?.budget ?? Infinity;
  // Sem `unfold` nenhum nível é gasto, então toda reentrada cai no mesmo nível e satura.
  const levelCost = isUndefined(unfold) ? 0 : 1;
  let steps = 0;
  let reentries = 0;

  const refSize = (ref: string, depth: number): number => {
    if (ref !== '#' && !ref.startsWith('#/')) return SATURATED;
    const reentriesBefore = reentries;
    if (inProgress.some((entry) => entry.ref === ref)) {
      reentries++;
      if (inProgress.some((entry) => entry.ref === ref && entry.depth === depth)) return SATURATED;
      if (depth < 0) return 0;
    }
    const known = refSizes.get(ref);
    if (!isUndefined(known)) return known;
    inProgress.push({ ref, depth });
    const size = sizeOf(valueAt(root, decodeURIComponent(ref.slice(1))), depth);
    inProgress.pop();
    // Quem passou por um ciclo depende do nível e do que está em curso: não se guarda
    if (reentries === reentriesBefore) refSizes.set(ref, size);
    return size;
  };

  const sizeOf = (node: unknown, depth: number, isRoot = false): number => {
    if (!isPlainObject(node)) return 0;
    if (++steps > budget) return SATURATED;
    // `$id` aninhado muda o recurso contra o qual o ajv resolve `#/...`: o destino medido aqui seria outro
    if (!isRoot && typeof node.$id === 'string') return SATURATED;
    let total = 1;
    if ('$dynamicRef' in node) total = SATURATED;
    if (typeof node.$ref === 'string') total += refSize(node.$ref, depth);
    const depthOf = (key: string) => (DESCENDING_KEYWORDS.has(key) ? depth - levelCost : depth);
    for (const key of SUBSCHEMA_KEYWORDS) total += sizeOf(node[key], depthOf(key));
    for (const key of SUBSCHEMA_LIST_KEYWORDS) {
      const list: unknown = node[key];
      if (Array.isArray(list)) for (const item of list) total += sizeOf(item, depthOf(key));
    }
    for (const key of SUBSCHEMA_MAP_KEYWORDS) {
      const map: unknown = node[key];
      if (DEFINITION_KEYWORDS.includes(key) || !isPlainObject(map)) continue;
      for (const child of Object.values(map)) total += sizeOf(child, depthOf(key));
    }
    return Math.min(total, SATURATED);
  };

  try {
    return sizeOf(root, unfold?.depth ?? 0, true);
  } catch (error) {
    // O orçamento sozinho não evita o estouro de pilha: cadeias longas de `not` aninhados o causam
    if (error instanceof RangeError) return SATURATED;
    throw error;
  }
}

/**
 * Quantos valores (objetos, arrays e escalares) o dado tem e a maior distância da raiz a um deles
 * (escalar na raiz vale 0), contados sem recursão; a contagem para ao passar de `limit`, então um
 * dado enorme não custa mais que o teto que o chamador compara (e `depth` fica só parcial).
 */
export function measureData(value: unknown, limit: number): { nodes: number; depth: number } {
  const pending = [{ node: value, level: 0 }];
  let nodes = 0;
  let depth = 0;
  for (let entry = pending.pop(); !isUndefined(entry) && nodes <= limit; entry = pending.pop()) {
    nodes++;
    depth = Math.max(depth, entry.level);
    const { node, level } = entry;
    const children = Array.isArray(node) ? node : isPlainObject(node) ? Object.values(node) : [];
    for (const child of children) pending.push({ node: child, level: level + 1 });
  }
  return { nodes, depth };
}
