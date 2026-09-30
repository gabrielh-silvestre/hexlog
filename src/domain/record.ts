import canonicalize from 'canonicalize';
import { z } from 'zod';
import { alias, Instant, NAME_SRC, Name, RecordId, Target } from './ids.ts';

/** Teto de `data` em caracteres canônicos (JCS), igual ao do 0.x. */
export const DATA_MAX_CHARS = 16_000;

/** Teto de itens por lote de `register`. */
export const BATCH_MAX = 50;

// Mora aqui, e não em relations.ts, porque Relation e RelationInput precisam dele em tempo de
// execução e relations.ts importa este arquivo; relations.ts o reexporta.
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

/** Relação como o agente a envia: `to` pode ser `@<alias>` e `kind` pode vir de `as` (D-10). */
export const RelationInput = z.strictObject({
  to: z.union([RecordId, AliasRef]),
  kind: RelationKind.optional(),
  as: Name.optional(),
});
export type RelationInput = z.infer<typeof RelationInput>;

// canonicalize só devolve undefined para entradas não serializáveis, que z.json() já recusou.
const Data = z
  .record(z.string(), z.json())
  .refine((data) => (canonicalize(data) ?? '').length <= DATA_MAX_CHARS, {
    message: `data exceeds ${DATA_MAX_CHARS} canonical characters`,
  });

export const HexRecord = z.strictObject({
  id: RecordId,
  type: Name,
  at: Instant,
  target: Target,
  author: Author,
  data: Data,
  relations: z.array(Relation),
});
export type HexRecord = z.infer<typeof HexRecord>;

export const BatchItem = z.strictObject({
  alias: alias.optional(),
  type: Name,
  target: Target,
  data: Data,
  relations: z.array(RelationInput).optional(),
});
export type BatchItem = z.infer<typeof BatchItem>;
