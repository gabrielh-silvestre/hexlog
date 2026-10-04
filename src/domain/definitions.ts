import { isEqual, isPlainObject } from 'es-toolkit';
import { z } from 'zod';
import { HexlogError } from '../errors.ts';
import { GateQuestion } from './gate.ts';
import { Name, TypeNames } from './ids.ts';
import { RelationKind, withCanonicalLimit } from './record.ts';

/** Teto do schema de um tipo em caracteres canônicos (JCS), igual ao do 0.x; docs/tetos-dominio-v1.md. */
export const RECORD_TYPE_MAX_CHARS = 16_000;

/** Teto de uma relação (`from`/`to`) e de um gate (`where`) em caracteres canônicos (JCS); docs/tetos-dominio-v1.md. */
export const RELATION_GATE_MAX_CHARS = 16_000;

/** Teto de perguntas por gate; docs/tetos-dominio-v1.md. */
export const GATE_QUESTIONS_MAX = 50;

/** JSON Schema de um tipo de registro (`define_type`); a validade do schema é do adaptador ajv. */
export const RecordType = withCanonicalLimit(
  z.record(z.string(), z.json()),
  RECORD_TYPE_MAX_CHARS,
  'type schema',
);
export type RecordType = z.infer<typeof RecordType>;

/**
 * Nome de relação: `from`/`to` são listas de nomes de tipo, não vazias e sem repetição. Omitida, a
 * ponta aceita qualquer tipo; `[]` não quer dizer "nenhum tipo" e é recusada.
 */
export const RelationName = withCanonicalLimit(
  z.strictObject({
    name: Name,
    kind: RelationKind,
    from: TypeNames.optional(),
    to: TypeNames.optional(),
  }),
  RELATION_GATE_MAX_CHARS,
  'relation',
);
export type RelationName = z.infer<typeof RelationName>;

export const Gate = withCanonicalLimit(
  z.strictObject({
    name: Name,
    // Gate vazio nunca barra; evaluateGate([]) segue vazio-verdadeiro, mas a definição não o admite.
    questions: z.array(GateQuestion).min(1).max(GATE_QUESTIONS_MAX),
  }),
  RELATION_GATE_MAX_CHARS,
  'gate',
);
export type Gate = z.infer<typeof Gate>;

/** Um número de versão `major.minor` (ex.: `1.9`). */
export type Version = { major: number; minor: number };

/**
 * Gramática canônica de versão, única para o domínio e para o nome de arquivo no store: sem zero à
 * esquerda (`01.0` e `1.0` seriam duas versões da mesma definição) e até 6 dígitos por segmento
 * (o número cabe em `Number` sem perda).
 */
export const CANONICAL_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/** Converte `"1.9"` em `{ major: 1, minor: 9 }`. */
export function parseVersion(v: string): Version {
  const match = CANONICAL_VERSION.exec(v);
  if (match === null) {
    throw new HexlogError('INTERNAL', `malformed version string '${v}'`);
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Converte `{ major: 1, minor: 9 }` em `"1.9"`. */
export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}`;
}

/** Compara duas versões numericamente por `(major, minor)`, nunca por string (`1.10` > `1.9`). */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  return va.major - vb.major || va.minor - vb.minor;
}

/** Próxima versão a partir de `current`: `minor` soma ao minor, `major` soma ao major e zera o minor. */
export function bumpVersion(current: string, kind: 'major' | 'minor'): Version {
  const { major, minor } = parseVersion(current);
  return kind === 'major' ? { major: major + 1, minor: 0 } : { major, minor: minor + 1 };
}

/** D-11: `unchanged` não grava versão, `compatible` sobe o minor, `breaking` exige `breaking: true`. */
export type Change = 'unchanged' | 'compatible' | 'breaking';

// Palavras-chave em que mudar o schema pode estreitar o que ele aceita: `if` e `not` invertem o
// sentido (propriedade nova ou `enum` alargado num deles recusa dado que antes passava), e
// `anyOf`/`allOf`/`oneOf` compõem o veredito de vários ramos. `then` e `else` ficam de fora de
// propósito: nova propriedade neles equivale a adicioná-la na raiz, que a D-11 já aceita (provado
// com ajv, `else` e raiz recusam o mesmo dado novo). `anyOf`/`allOf`/`oneOf` são arrays e já caem
// em `isEqual`; ficam na lista para seguir valendo se o percurso passar a entrar em arrays.
const NON_ADDITIVE_KEYWORDS = new Set(['not', 'if', 'anyOf', 'allOf', 'oneOf']);

// `keyword` é a chave pela qual `previous` foi alcançado, ou null na raiz e dentro de um mapa de
// propriedades (aí as chaves são nomes de campo do projeto, não palavras-chave). `additive` é falso
// desde que o percurso entrou numa palavra-chave de NON_ADDITIVE_KEYWORDS: dali em diante vale
// igualdade estrita, sem chave nova e sem `enum` alargado.
// ponytail: não distingue schema de valor de dado (`default`, `const`); um mapa `properties` dentro
// deles também aceita chaves novas. Também não segue `$ref`: `enum` alargado em `$defs` usado sob
// `not` passa como compatível. Precisa de um percurso ciente de palavras-chave se isso pesar.
function onlyAdds(
  previous: unknown,
  next: unknown,
  keyword: string | null,
  additive: boolean,
): boolean {
  if (isPlainObject(previous) && isPlainObject(next)) {
    const isPropertyMap = keyword === 'properties';
    const keepsEveryKey = Object.keys(previous).every(
      (key) =>
        Object.hasOwn(next, key) &&
        onlyAdds(
          previous[key],
          next[key],
          isPropertyMap ? null : key,
          additive && (isPropertyMap || !NON_ADDITIVE_KEYWORDS.has(key)),
        ),
    );
    return (
      keepsEveryKey &&
      ((isPropertyMap && additive) ||
        Object.keys(next).every((key) => Object.hasOwn(previous, key)))
    );
  }
  if (additive && keyword === 'enum' && Array.isArray(previous) && Array.isArray(next)) {
    return previous.every((value) => next.some((candidate) => isEqual(candidate, value)));
  }
  return isEqual(previous, next);
}

/**
 * D-11: só é compatível a mudança que adiciona propriedade (sem a pôr em `required`, que é um
 * array comparado por igualdade) ou valor de `enum`; qualquer outra diferença é quebra.
 */
export function classifyTypeChange(previous: RecordType, next: RecordType): Change {
  if (isEqual(previous, next)) return 'unchanged';
  return onlyAdds(previous, next, null, true) ? 'compatible' : 'breaking';
}

/** Ponta ausente aceita qualquer tipo: `next` alarga `previous` quando aceita tudo que ele aceitava. */
function widens(previous: string[] | undefined, next: string[] | undefined): boolean {
  if (next === undefined) return true;
  if (previous === undefined) return false;
  return previous.every((typeName) => next.includes(typeName));
}

/** D-11: alargar `from`/`to` é compatível; trocar `kind` ou estreitar qualquer lista é quebra. */
export function classifyRelationChange(previous: RelationName, next: RelationName): Change {
  if (isEqual(previous, next)) return 'unchanged';
  const keepsShape =
    previous.kind === next.kind && widens(previous.from, next.from) && widens(previous.to, next.to);
  return keepsShape ? 'compatible' : 'breaking';
}

const ATTACHMENT_FORMAT = 'attachment';

function hasAttachmentFormat(fieldSchema: unknown): boolean {
  if (!isPlainObject(fieldSchema)) return false;
  if (fieldSchema.format === ATTACHMENT_FORMAT) return true;
  return isPlainObject(fieldSchema.items) && fieldSchema.items.format === ATTACHMENT_FORMAT;
}

/** D-16: campos de primeiro nível de `data` marcados com `format: "attachment"` (direto ou em `items`). */
export function attachmentFields(schema: RecordType): string[] {
  const properties: unknown = schema.properties;
  if (!isPlainObject(properties)) return [];
  return Object.keys(properties).filter((field) => hasAttachmentFormat(properties[field]));
}
