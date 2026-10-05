import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { omit } from 'es-toolkit';
import { z } from 'zod';
import { HexlogError } from '../errors.ts';
import { alias, Hash, RecordId } from './ids.ts';
import { BATCH_MAX, BatchItem, HexRecord } from './record.ts';

/** Tetos de `Batch.key` (caracteres) e `Batch.aliases` (entradas); docs/tetos-dominio-v1.md. */
export const BATCH_KEY_MAX = 200;
/** Um alias por item no máximo, então o teto acompanha `BATCH_MAX`. */
export const BATCH_ALIASES_MAX = BATCH_MAX;

/** Forma da chave de idempotência; a tool `register` soma a boa formação, que o log gravado não revalida. */
export const BatchKey = z.string().min(1).max(BATCH_KEY_MAX);

/** D-04: só o 1º elo do lote leva `batch`, dentro do hash. */
export const Batch = z.strictObject({
  fingerprint: Hash,
  key: BatchKey.optional(),
  aliases: z
    .record(alias, RecordId)
    .refine((aliases) => Object.keys(aliases).length <= BATCH_ALIASES_MAX, {
      message: `aliases exceed ${BATCH_ALIASES_MAX} entries`,
    })
    .optional(),
});
export type Batch = z.infer<typeof Batch>;

/** D-04: o registro mais os campos da cadeia; `seq` é lógico e contíguo por processo. */
export const Link = HexRecord.extend({
  seq: z.number().int().min(0),
  prevHash: Hash,
  batch: Batch.optional(),
});
export type Link = z.infer<typeof Link>;

/** Posição que o próximo elo do log precisa ocupar. */
export type Expected = { seq: number; prevHash: Hash };

// canonicalize devolve undefined para valor sem forma JSON (undefined, função, símbolo) e lança para
// NaN, BigInt e surrogate solitário. Devolver '' para o primeiro caso daria o mesmo hash a entradas
// diferentes, então vira INTERNAL: só chega aqui valor que os schemas não validaram.
function jcs(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) throw new HexlogError('INTERNAL', 'value is not canonicalizable');
  return text;
}

export function sha256hex(data: string | Uint8Array): Hash {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 do JCS do valor: o hash de conteúdo de manifesto, definição e lote. */
export function hashOfJcs(value: unknown): Hash {
  return sha256hex(jcs(value));
}

/** D-06: sha256 do JCS dos itens de entrada, sem `key` e sem `agent`/`model`. */
export function fingerprint(items: readonly BatchItem[]): Hash {
  return hashOfJcs(items);
}

/** D-04: `hashLink(l) = sha256hex(l.prevHash + JCS(l sem prevHash))`. */
export function hashLink(link: Link): Hash {
  return sha256hex(link.prevHash + jcs(omit(link, ['prevHash'])));
}

/** D-03: âncora da cadeia de um processo, `sha256hex(JCS(manifesto))`. */
export function anchor(manifest: unknown): Hash {
  return hashOfJcs(manifest);
}

/** Por que o valor não ocupa a posição esperada: forma inválida, `seq` ou `prevHash` divergentes. */
export type LinkRejection = 'invalid-line' | 'diverging-seq' | 'hash-mismatch';

type LinkCheck = { link: Link } | { reasons: LinkRejection[] };

// O parse lança para aninhamento profundo (pilha do zod) e surrogate solitário; ambos são linha inválida.
function parseLink(value: unknown): Link | undefined {
  try {
    const result = Link.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Predicado único de elo (escritor e verificador): o valor tem a forma de `Link`, dentro dos tetos,
 * e ocupa a posição esperada. Devolve o elo, ou as razões: só `invalid-line` quando a forma falha,
 * e `diverging-seq` e `hash-mismatch` juntas quando as duas posições divergem. Continuidade interna
 * do lote e hash são do enquadramento em disco (`shared/loader.ts#isValidLine`, D-05). Invariante:
 * sem `invalid-line` em `reasons`, o valor passou em `parseLink`, então `Link.parse` não lança; o
 * chamador que precisa do elo rejeitado repete o parse (`shared/loader.ts#checkLinks`).
 */
export function isValidLink(value: unknown, expected: Expected): LinkCheck {
  const link = parseLink(value);
  if (link === undefined) return { reasons: ['invalid-line'] };
  const reasons: LinkRejection[] = [];
  if (link.seq !== expected.seq) reasons.push('diverging-seq');
  if (link.prevHash !== expected.prevHash) reasons.push('hash-mismatch');
  return reasons.length === 0 ? { link } : { reasons };
}
