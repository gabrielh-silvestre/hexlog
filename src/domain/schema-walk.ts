import { isPlainObject } from 'es-toolkit';
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
  const segments = location === '' ? [] : location.split('/').slice(1);
  let node = schema;
  for (const raw of segments) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, segment)) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return isPlainObject(node) && Object.hasOwn(node, keyword);
}
