import type { Hash, Name, RecordId } from './domain/ids.ts';
import type { Gate, RecordType, RelationName } from './domain/definitions.ts';
import type { Manifest } from './domain/manifest.ts';
import type { HexRecord } from './domain/record.ts';
import type { Detail } from './errors.ts';

export type { Manifest };

/** Processo = par projeto/nome; o id de um registro carrega só o processo (D-01). */
export type ProcessRef = { project: Name; process: Name };

/** Processo como está no disco: o manifesto e os bytes do log, sem interpretar linha nenhuma. */
export type RawProcess = {
  manifest: Manifest;
  text: string;
  /** Arquivo vazio conta como terminado, como o de um processo recém-criado. */
  endsWithNewline: boolean;
};

/**
 * O que `decide` devolve a `ProcessStore.write`: `line` já enquadrada por
 * `shared/loader.ts#formatLine` (o adaptador só acrescenta o `\n` de prefixo, se precisar), ou
 * ausente quando não há nada a gravar (replay, D-06); `result` é a resposta de `write`.
 */
export type Decision<T> = { line?: string; result: T };

/**
 * D-25: toda operação é síncrona, exceto `write`, que é `async` só porque a espera do lock dorme
 * com `setTimeout`. Toda regra de negócio fica em `decide`; o adaptador só sabe de bytes, lock e
 * prefixo `\n`.
 */
export type ProcessStore = {
  /** `PROCESS_NOT_FOUND` se não existe; `PROCESS_CORRUPTED` (`unreadable-manifest`) se o manifesto não lê. */
  read(ref: ProcessRef): RawProcess;
  /** Nomes dos processos do projeto. */
  list(project: Name): Name[];
  listProjects(): Name[];
  /** `false` quando o processo já existe: o manifesto existente nunca é tocado. */
  create(ref: ProcessRef, manifest: Manifest): boolean;
  /**
   * Adquire o lock, lê o processo cru e chama `decide`, que é síncrona e pode lançar `HexlogError`;
   * grava `line` (se houver), faz fsync, solta o lock e devolve `result`.
   */
  write<T>(ref: ProcessRef, decide: (raw: RawProcess) => Decision<T>): Promise<T>;
};

export type DefinitionKind = 'types' | 'relations' | 'gates';

/** Definição guardada por pasta (`types/`, `relations/`, `gates/`). */
export type DefinitionOf = { types: RecordType; relations: RelationName; gates: Gate };

/** Versões imutáveis `<major>.<minor>` de tipos, nomes de relação e gates de um projeto. */
export type DefinitionStore = {
  names(project: Name, kind: DefinitionKind): Name[];
  versions(project: Name, kind: DefinitionKind, name: Name): string[];
  read<K extends DefinitionKind>(
    project: Name,
    kind: K,
    name: Name,
    version: string,
  ): DefinitionOf[K];
  /** `false` quando a versão já existe: uma versão gravada nunca é sobrescrita. */
  write<K extends DefinitionKind>(
    project: Name,
    kind: K,
    name: Name,
    version: string,
    definition: DefinitionOf[K],
  ): boolean;
};

export type AttachmentStatus = 'ok' | 'missing' | 'corrupted';

/** Blobs imutáveis endereçados pelo sha256 dos bytes UTF-8, em `<projeto>/attachments/<sha256>`. */
export type AttachmentStore = {
  putText(project: Name, text: string): { hash: Hash; bytes: number };
  putPath(project: Name, path: string): { hash: Hash; bytes: number };
  status(project: Name, hash: Hash): AttachmentStatus;
  /** `ATTACHMENT_NOT_FOUND` ou `ATTACHMENT_CORRUPTED`; a paginação é do serviço. */
  read(project: Name, hash: Hash): string;
};

/** JSON Schema: `Detail[]` vazio = aprovado. */
export type Validator = {
  checkSchema(schema: RecordType): Detail[];
  validate(schema: RecordType, data: HexRecord['data']): Detail[];
};

/** Índice montado por chamada sobre os registros já carregados; devolve ids por relevância. */
export type SearchIndex = {
  search(records: readonly HexRecord[], text: string): RecordId[];
};
