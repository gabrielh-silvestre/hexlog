import type { Name, RecordId } from '../domain/ids.ts';
import type { Author, BatchItem } from '../domain/record.ts';

/** D-24: uma entrada por processo lido; `null` para processo vazio. O `register` devolve só a da origem. */
export type Marker = Record<Name, RecordId | null>;

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
