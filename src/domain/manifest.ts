import { z } from 'zod';
import { Gate, RecordType, RelationName } from './definitions.ts';
import { Hash, Instant, Name } from './ids.ts';

/**
 * D-03: `process.json`; a âncora da cadeia é o sha256 do JCS deste objeto. Os objetos são estritos
 * para que o parse não descarte chave nenhuma: o que `anchor` hasheia é o que está no disco.
 */
export const Manifest = z.strictObject({
  project: Name,
  process: Name,
  createdAt: Instant,
  fixed: z.strictObject({
    types: z.record(Name, RecordType),
    relations: z.record(Name, RelationName),
    gates: z.record(Name, Gate),
  }),
  hashes: z.strictObject({ types: Hash, relations: Hash, gates: Hash }),
});
export type Manifest = z.infer<typeof Manifest>;
