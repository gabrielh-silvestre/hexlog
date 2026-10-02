import { z } from 'zod';

// D-01: regex única de nome para project, process, type, relation name e gate.
export const NAME_SRC = '[a-z0-9][a-z0-9-]{0,62}';
export const Name = z.string().regex(new RegExp(`^${NAME_SRC}$`));
export type Name = z.infer<typeof Name>;

export const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export type Hash = z.infer<typeof Hash>;

export const Instant = z.iso.datetime();
export type Instant = z.infer<typeof Instant>;

/** D-07: segmentos `Name` separados por `.`, no máximo 200 caracteres, sem ponto final. */
export const Target = z
  .string()
  .max(200)
  .regex(new RegExp(`^${NAME_SRC}(\\.${NAME_SRC})*$`));
export type Target = z.infer<typeof Target>;

const UUID_V7_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/** D-01: `<process>:<uuidv7>`; o servidor atribui, o agente nunca escolhe. */
export const RecordId = z.string().regex(new RegExp(`^${NAME_SRC}:${UUID_V7_SRC}$`));
export type RecordId = z.infer<typeof RecordId>;

/** D-24: uma entrada por processo lido; `null` para processo vazio. Só tipo: nenhum consumidor valida. */
export type Marker = Record<Name, RecordId | null>;

/**
 * Lista de nomes de tipo de registro, sem repetição. Omitida, a ponta que a usa aceita qualquer
 * tipo; lista vazia nunca significa "nenhum tipo", por isso `.min(1)`.
 */
export const TypeNames = z
  .array(Name)
  .min(1)
  .refine((names) => new Set(names).size === names.length, { message: 'duplicate type name' });

/** D-01: apelido de um item do lote, citado pelos itens seguintes como `@<alias>`. */
export const alias = Name;
export type Alias = z.infer<typeof alias>;

/** Processo dono do registro: o trecho do id antes do `:`, sem leitura de disco (Q1). */
export function processOf(id: RecordId): Name {
  return id.slice(0, id.indexOf(':'));
}

/** D-02/TI5: nomes de processo que colidem com pastas do projeto. */
export const RESERVED_PROCESS_NAMES = [
  'types',
  'relations',
  'gates',
  'attachments',
  'archive',
] as const;
