import { isEqual, isPlainObject } from 'es-toolkit';
import { z } from 'zod';
import { HexlogError } from '../errors.ts';
import { Name } from './ids.ts';
import { RelationKind } from './record.ts';

/** JSON Schema de um tipo de registro (`define_type`); a validade do schema é do adaptador ajv. */
export const RecordType = z.record(z.string(), z.json());
export type RecordType = z.infer<typeof RecordType>;

/** Nome de relação: `from`/`to` são listas de nomes de tipo; omitida, a ponta aceita qualquer tipo. */
export const RelationName = z.strictObject({
  name: Name,
  kind: RelationKind,
  from: z.array(Name).optional(),
  to: z.array(Name).optional(),
});
export type RelationName = z.infer<typeof RelationName>;

// Forma mínima enquanto gate.ts não existe: só confere que cada pergunta é um objeto com `kind`.
// gate.ts troca isto pelo `GateQuestion` completo.
const GateQuestionShape = z.looseObject({ kind: z.string() });

export const Gate = z.strictObject({
  name: Name,
  questions: z.array(GateQuestionShape),
});
export type Gate = z.infer<typeof Gate>;

/** Um número de versão `major.minor` (ex.: `1.9`). */
export type Version = { major: number; minor: number };

const VERSION_STRING_RE = /^(\d+)\.(\d+)$/;

/** Converte `"1.9"` em `{ major: 1, minor: 9 }`. */
export function parseVersion(v: string): Version {
  const match = VERSION_STRING_RE.exec(v);
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

// `keyword` é a chave pela qual `previous` foi alcançado, ou null na raiz e dentro de um mapa de
// propriedades (aí as chaves são nomes de campo do projeto, não palavras-chave).
// ponytail: não distingue schema de valor de dado (`default`, `const`); um mapa `properties` dentro
// deles também aceita chaves novas. Precisa de um percurso ciente de palavras-chave se isso pesar.
function onlyAdds(previous: unknown, next: unknown, keyword: string | null): boolean {
  if (isPlainObject(previous) && isPlainObject(next)) {
    const isPropertyMap = keyword === 'properties';
    const keepsEveryKey = Object.keys(previous).every(
      (key) =>
        Object.hasOwn(next, key) && onlyAdds(previous[key], next[key], isPropertyMap ? null : key),
    );
    return (
      keepsEveryKey &&
      (isPropertyMap || Object.keys(next).every((key) => Object.hasOwn(previous, key)))
    );
  }
  if (keyword === 'enum' && Array.isArray(previous) && Array.isArray(next)) {
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
  return onlyAdds(previous, next, null) ? 'compatible' : 'breaking';
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
