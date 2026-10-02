import { jest } from '@jest/globals';
import { createValidator } from '../../src/adapters/validator.ts';
import { createProcessService } from '../../src/commands/process.ts';
import type { RegisterInput } from '../../src/commands/process.ts';
import { anchor } from '../../src/domain/chain.ts';
import type { RecordType, RelationName } from '../../src/domain/definitions.ts';
import type { Hash, Name } from '../../src/domain/ids.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { HexlogError } from '../../src/errors.ts';
import { verifyProcess } from '../../src/shared/loader.ts';
import type { Logger } from '../../src/shared/logger.ts';
import { rejectionOf } from '../helpers.ts';
import type {
  AttachmentStatus,
  AttachmentStore,
  Decision,
  DefinitionStore,
  Manifest,
  ProcessRef,
  ProcessStore,
  RawProcess,
} from '../../src/ports.ts';

export const PROJECT = 'alpha';
export const ORIGIN = 'run-1';
export const NOW = new Date('2026-10-02T12:00:00.000Z');
export const AUTHOR = { agent: 'executor', model: 'sonnet', client: 'claude-code' };

export const NOTE: RecordType = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

/** Tipo com campos de anexo marcados (D-16) e um campo livre que um hash pode vazar para ele. */
export const DOC: RecordType = {
  type: 'object',
  properties: {
    body: { type: 'string', format: 'attachment' },
    files: { type: 'array', items: { type: 'string', format: 'attachment' } },
    note: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const DEFAULT_RELATIONS: RelationName[] = [
  { name: 'approves', kind: 'supports' },
  { name: 'replaces', kind: 'supersedes' },
  { name: 'only-tasks', kind: 'supports', from: ['task'] },
];

export type Types = Record<Name, RecordType>;

export function manifestOf(
  process: Name,
  types: Types = { note: NOTE, task: NOTE, doc: DOC },
  relations: RelationName[] = DEFAULT_RELATIONS,
): Manifest {
  const fixed = {
    types,
    relations: Object.fromEntries(relations.map((relation) => [relation.name, relation])),
    gates: {},
  };
  return {
    project: PROJECT,
    process,
    createdAt: NOW.toISOString(),
    fixed,
    hashes: { types: anchor(fixed.types), relations: anchor(fixed.relations), gates: anchor({}) },
  };
}

const HEX = (n: number) => n.toString(16).padStart(12, '0');

/** Uuid v7 válido e determinista: o contador entra nos últimos 12 dígitos. */
export function createUuids(): () => string {
  let counter = 0;
  return () => `00000000-0000-7000-8000-${HEX(++counter)}`;
}

/** Operação de porta que o spec não deve exercitar: falha alto se alguém a chamar. */
export const refuse = (): never => {
  throw new Error('operação fora do escopo deste spec');
};

function notFound(process: Name): HexlogError {
  const message = 'process not found';
  return new HexlogError('PROCESS_NOT_FOUND', message, [
    { path: '/process', code: 'not-found', message, process },
  ]);
}

function tooLarge(): HexlogError {
  const message = 'process log exceeds the size limit';
  return new HexlogError('PROCESS_TOO_LARGE', message, [
    { path: '/process', code: 'too-large', message },
  ]);
}

/**
 * `ProcessStore` em memória cujo `write(ref, decide)` é de verdade: lê o processo cru, chama
 * `decide` e só então anexa a linha (com o `\n` de prefixo). Não tem lock. Os contadores deixam
 * os testes provarem "nenhuma gravação" (`appends`) e o fsync do replay (`syncsWithoutLine`).
 */
export function fakeProcessStore() {
  const entries = new Map<Name, { manifest: Manifest; text: string }>();
  const flags = {
    /** Processos cuja leitura devolve `PROCESS_TOO_LARGE` (log acima do teto antes de `decide`). */
    tooLarge: new Set<Name>(),
    /** Processos cujo manifesto é ilegível. */
    unreadable: new Set<Name>(),
    /** Teto do arquivo na escrita, como `MAX_LOG_BYTES` do adaptador. */
    maxBytes: Infinity,
    /** Grava a linha e falha depois (`write` completo e `fsync` que falhou): resultado incerto. */
    ioErrorAfterAppend: false,
  };
  const counters = { reads: [] as Name[], writes: 0, appends: 0, syncsWithoutLine: 0 };

  /** Como `readManifest` do adaptador: só o manifesto, sem o teto do log nem a contagem de leitura do log. */
  const manifestEntryOf = (process: Name) => {
    const entry = entries.get(process);
    if (entry === undefined) throw notFound(process);
    if (flags.unreadable.has(process)) {
      const message = 'process manifest is unreadable';
      throw new HexlogError('PROCESS_CORRUPTED', message, [
        { path: '/process', code: 'unreadable-manifest', message, process },
      ]);
    }
    return entry;
  };

  const rawOf = (process: Name): RawProcess => {
    counters.reads.push(process);
    const { manifest, text } = manifestEntryOf(process);
    if (flags.tooLarge.has(process)) throw tooLarge();
    return { manifest, text, endsWithNewline: text === '' || text.endsWith('\n') };
  };

  const store: ProcessStore = {
    read: (ref) => rawOf(ref.process),
    readManifest: (ref) => manifestEntryOf(ref.process).manifest,
    list: refuse,
    listProjects: refuse,
    create: refuse,
    // `Promise` com executor síncrono: o `throw` de `decide` ou do veto vira rejeição, como no adaptador.
    write: (ref, decide) =>
      new Promise((resolve) => {
        resolve(writeNow(ref, decide));
      }),
  };

  function writeNow<T>(ref: ProcessRef, decide: (raw: RawProcess) => Decision<T>): T {
    counters.writes += 1;
    const raw = rawOf(ref.process);
    const decision = decide(raw);
    if (decision.line === undefined) {
      counters.syncsWithoutLine += 1;
      return decision.result;
    }
    const entry = entries.get(ref.process)!;
    const text = `${raw.endsWithNewline ? '' : '\n'}${decision.line}`;
    if (Buffer.byteLength(entry.text) + Buffer.byteLength(text) > flags.maxBytes) {
      throw tooLarge();
    }
    entry.text += text;
    counters.appends += 1;
    if (flags.ioErrorAfterAppend) {
      throw new HexlogError('IO_ERROR', 'I/O failure', [
        { path: '', code: 'enospc', message: 'I/O failure' },
      ]);
    }
    return decision.result;
  }

  return {
    store,
    flags,
    counters,
    add: (process: Name, manifest = manifestOf(process)) => {
      entries.set(process, { manifest, text: '' });
    },
    textOf: (process: Name) => entries.get(process)?.text ?? '',
    /** Substitui o log cru, para montar cadeia quebrada ou cauda rasgada. */
    setText: (process: Name, text: string) => {
      const entry = entries.get(process);
      if (entry !== undefined) entry.text = text;
    },
  };
}

/** `AttachmentStore` em memória: só `status`, que é o que `register` usa; conta as consultas. */
export function fakeAttachments() {
  const statuses = new Map<Hash, AttachmentStatus>();
  const calls: Hash[] = [];
  const store: AttachmentStore = {
    putText: refuse,
    putPath: refuse,
    read: refuse,
    status: (_project, hash) => {
      calls.push(hash);
      return statuses.get(hash) ?? 'missing';
    },
  };
  return {
    store,
    calls,
    set: (hash: Hash, status: AttachmentStatus) => void statuses.set(hash, status),
  };
}

const REFUSING_DEFINITIONS: DefinitionStore = {
  names: () => [],
  versions: () => [],
  read: refuse,
  write: refuse,
};

/** Portas de `register` que um spec de `createProcess` não usa, só para completar as dependências. */
export const UNUSED_REGISTER_PORTS = {
  attachments: fakeAttachments().store,
  validator: createValidator(),
  newUuid: createUuids(),
  logger: () => undefined,
};

export function setup() {
  const processes = fakeProcessStore();
  const attachments = fakeAttachments();
  const validator = createValidator();
  const validate = jest.spyOn(validator, 'validate');
  const logger = jest.fn<Logger>();
  let now = NOW;
  const service = createProcessService({
    store: processes.store,
    definitions: REFUSING_DEFINITIONS,
    attachments: attachments.store,
    validator,
    clock: () => now,
    newUuid: createUuids(),
    logger,
  });
  processes.add(ORIGIN);
  return {
    service,
    logger,
    processes,
    attachments,
    validate,
    setNow: (date: Date) => void (now = date),
    register: (records: BatchItem[], extra: Partial<RegisterInput> = {}, process: Name = ORIGIN) =>
      service.register({ project: PROJECT, process, author: AUTHOR, records, ...extra }),
  };
}

export const note = (text = 'x', extra: Partial<BatchItem> = {}): BatchItem => ({
  type: 'note',
  target: 'run.step',
  data: { text },
  ...extra,
});

/** Espera a rejeição de domínio e confere que ela não vaza pilha nem caminho de módulo (D-26). */
export const refusal = (promise: Promise<unknown>) => rejectionOf(promise, 'node_modules');

export const verifiedOf = (
  processes: ReturnType<typeof fakeProcessStore>,
  process: Name = ORIGIN,
) => verifyProcess(processes.store.read({ project: PROJECT, process }));

/** Id de registro bem formado (D-01) de um processo que nunca recebeu o registro. */
export const ghostId = (process: Name, n = 999) => `${process}:00000000-0000-7000-8000-${HEX(n)}`;
