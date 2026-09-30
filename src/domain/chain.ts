import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { omit } from 'es-toolkit';
import { z } from 'zod';
import { alias, Hash, RecordId } from './ids.ts';
import { BatchItem, HexRecord } from './record.ts';

/** D-04: só o 1º elo do lote leva `batch`, dentro do hash. */
export const Batch = z.strictObject({
  fingerprint: Hash,
  key: z.string().min(1).optional(),
  aliases: z.record(alias, RecordId).optional(),
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

// canonicalize só devolve undefined para entradas não serializáveis, que os schemas já recusaram.
function jcs(value: unknown): string {
  return canonicalize(value) ?? '';
}

export function sha256hex(data: string | Uint8Array): Hash {
  return createHash('sha256').update(data).digest('hex');
}

/** D-06: sha256 do JCS dos itens de entrada, sem `key` e sem `agent`/`model`. */
export function fingerprint(items: readonly BatchItem[]): Hash {
  return sha256hex(jcs(items));
}

/** D-04: `hashLink(l) = sha256hex(l.prevHash + JCS(l sem prevHash))`. */
export function hashLink(link: Link): Hash {
  return sha256hex(link.prevHash + jcs(omit(link, ['prevHash'])));
}

/** D-03: âncora da cadeia de um processo, `sha256hex(JCS(manifesto))`. */
export function anchor(manifest: unknown): Hash {
  return sha256hex(jcs(manifest));
}

/**
 * Predicado único de elo (escritor e verificador): o valor tem a forma de `Link` e ocupa a
 * posição esperada (`seq` e `prevHash`); devolve o elo, ou `null`. Continuidade interna do lote
 * e hash são do enquadramento em disco (`shared/loader.ts#isValidLine`, D-05).
 */
export function isValidLink(value: unknown, expected: Expected): Link | null {
  const result = Link.safeParse(value);
  if (!result.success) return null;
  const link = result.data;
  return link.seq === expected.seq && link.prevHash === expected.prevHash ? link : null;
}
