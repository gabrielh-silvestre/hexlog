import canonicalize from 'canonicalize';
import { z } from 'zod';
import { alias, Instant, NAME_SRC, Name, RecordId, Target } from './ids.ts';

/**
 * Teto de `data` em caracteres canônicos (JCS), igual ao do 0.x. Conta unidades UTF-16 do JCS, então
 * um emoji vale 2. `isValidLink` reaplica este schema na releitura: apertar o teto, uma regex ou um
 * `strictObject` invalida linha já gravada, e por isso é mudança de formato (major).
 */
export const DATA_MAX_CHARS = 16_000;

/** Teto de itens por lote de `register`. */
export const BATCH_MAX = 50;

/** Teto de relações por registro gravado e por item de lote (docs/tetos-dominio-v1.md). */
export const RELATIONS_MAX = 100;

/**
 * Exige que o valor caiba em `max` caracteres canônicos (JCS); `what` abre a mensagem de recusa.
 * Valor que o `canonicalize` recusa (surrogate solitário) conta como fora do teto em vez de lançar,
 * para o parse devolver erro de validação.
 */
export function withCanonicalLimit<T extends z.ZodType>(schema: T, max: number, what: string): T {
  return schema.refine(
    (value) => {
      try {
        return (canonicalize(value) ?? '').length <= max;
      } catch {
        return false;
      }
    },
    { message: `${what} exceeds ${max} canonical characters or is not canonicalizable` },
  );
}

// Mora aqui, e não em relations.ts, porque Relation e RelationInput precisam dele em tempo de
// execução e relations.ts importa este arquivo.
export const RelationKind = z.enum([
  'supersedes',
  'revokes',
  'supports',
  'contradicts',
  'answers',
  'derivesFrom',
  'complements',
  'reopens',
]);
export type RelationKind = z.infer<typeof RelationKind>;

const AuthorField = z.string().min(1).max(100);

export const Author = z.strictObject({
  agent: AuthorField,
  model: AuthorField.optional(),
  client: AuthorField,
});
export type Author = z.infer<typeof Author>;

/** Relação gravada: `kind` sempre resolvido, `to` sempre um id (D-10). */
export const Relation = z.strictObject({
  kind: RelationKind,
  to: RecordId,
  as: Name.optional(),
});
export type Relation = z.infer<typeof Relation>;

/** Referência a um item anterior do mesmo lote (D-01). */
export const AliasRef = z.string().regex(new RegExp(`^@${NAME_SRC}$`));

/**
 * Relação como o agente a envia: `to` pode ser `@<alias>` e `kind` pode vir de `as` (D-10).
 * Pelo menos um dos dois precisa vir.
 */
export const RelationInput = z
  .strictObject({
    to: z.union([RecordId, AliasRef]),
    kind: RelationKind.optional(),
    as: Name.optional(),
  })
  .refine(({ kind, as }) => kind !== undefined || as !== undefined, {
    message: 'relation needs kind or as',
    path: ['kind'],
  });

/** `kind`, `as` ou os dois: o refine de `RelationInput` garante um deles, e o tipo também. */
export type KindOrAs = { kind: RelationKind; as?: undefined } | { kind?: RelationKind; as: Name };
export type RelationInput = z.infer<typeof RelationInput> & KindOrAs;

// canonicalize só devolve undefined para entradas não serializáveis, que z.json() já recusou.
const Data = withCanonicalLimit(z.record(z.string(), z.json()), DATA_MAX_CHARS, 'data');

export const HexRecord = z.strictObject({
  id: RecordId,
  type: Name,
  at: Instant,
  target: Target,
  author: Author,
  data: Data,
  relations: z.array(Relation).max(RELATIONS_MAX),
});
export type HexRecord = z.infer<typeof HexRecord>;

export const BatchItem = z.strictObject({
  alias: alias.optional(),
  type: Name,
  target: Target,
  data: Data,
  relations: z.array(RelationInput).max(RELATIONS_MAX).optional(),
});
export type BatchItem = z.infer<typeof BatchItem>;
