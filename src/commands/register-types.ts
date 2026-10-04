import type { Marker, Name, RecordId } from '../domain/ids.ts';
import type { Author, BatchItem } from '../domain/record.ts';

/**
 * A entrada chega validada pelos schemas de `domain/record.ts` (`BatchItem`, `Author`, `key`): o
 * serviço não revalida. Fora do formato, a última barreira (`isValidLine`) devolve `INTERNAL` sem
 * `details`.
 */
export type RegisterInput = {
  project: Name;
  /** Processo de origem: o único que a gravação trava (D-12). */
  process: Name;
  /** D-21: `author.client` chega do adaptador, o serviço nunca o descobre sozinho. */
  author: Author;
  /** Idempotência (D-06): mesma `key` com a mesma impressão devolve o lote já gravado. */
  key?: string;
  records: readonly BatchItem[];
};

export type RegisteredRecord = { alias?: Name; id: RecordId };

export type RegisterResult = {
  records: RegisteredRecord[];
  replayed: boolean;
  /** Cabeça da origem lida em `decide`: o último id gravado (ou, no replay, o da cabeça atual). */
  marker: Marker;
};
