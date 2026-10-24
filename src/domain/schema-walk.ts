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
const SATURATED = Number.MAX_SAFE_INTEGER;

/**
 * Tamanho expandido do schema: quantos subschemas uma validação pode visitar num valor só, contando
 * cada `$ref` pelo tamanho do destino (`$defs` só entra por quem o cita). Memoiza o destino de cada
 * `$ref`, então o custo é linear no documento mesmo quando as referências dobram a cada nível.
 * `$ref` que não é ponteiro local (`#/...`), `$dynamicRef` e ciclo valem `SATURATED`: sem como
 * medir aqui, assume-se o pior.
 */
export function expandedSize(root: unknown): number {
  const refSizes = new Map<string, number>();
  const resolving = new Set<string>();

  const refSize = (ref: string): number => {
    if (!ref.startsWith('#/') || resolving.has(ref)) return SATURATED;
    const known = refSizes.get(ref);
    if (!isUndefined(known)) return known;
    resolving.add(ref);
    const size = sizeOf(valueAt(root, decodeURIComponent(ref.slice(1))));
    resolving.delete(ref);
    refSizes.set(ref, size);
    return size;
  };

  const sizeOf = (node: unknown): number => {
    if (!isPlainObject(node)) return 0;
    let total = 1;
    if ('$dynamicRef' in node) total = SATURATED;
    if (typeof node.$ref === 'string') total += refSize(node.$ref);
    for (const key of SUBSCHEMA_KEYWORDS) total += sizeOf(node[key]);
    for (const key of SUBSCHEMA_LIST_KEYWORDS) {
      const list: unknown = node[key];
      if (Array.isArray(list)) for (const item of list) total += sizeOf(item);
    }
    for (const key of SUBSCHEMA_MAP_KEYWORDS) {
      const map: unknown = node[key];
      if (DEFINITION_KEYWORDS.includes(key) || !isPlainObject(map)) continue;
      for (const child of Object.values(map)) total += sizeOf(child);
    }
    return Math.min(total, SATURATED);
  };

  return sizeOf(root);
}

/**
 * Quantos valores (objetos, arrays e escalares) o dado tem, contados sem recursão; a contagem para
 * ao passar de `limit`, então um dado enorme não custa mais que o teto que o chamador compara.
 */
export function countNodes(value: unknown, limit: number): number {
  const pending = [value];
  let count = 0;
  while (pending.length > 0 && count <= limit) {
    const node = pending.pop();
    count++;
    if (Array.isArray(node)) for (const item of node) pending.push(item);
    else if (isPlainObject(node)) for (const item of Object.values(node)) pending.push(item);
  }
  return count;
}
