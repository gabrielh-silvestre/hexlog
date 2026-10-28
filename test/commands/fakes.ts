import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import { compose } from '../../src/compose.ts';
import { createValidator } from '../../src/adapters/validator.ts';
import { createProcessService } from '../../src/commands/process.ts';
import type { RegisterInput } from '../../src/commands/process.ts';
import { hashOfJcs } from '../../src/domain/chain.ts';
import { compareVersions } from '../../src/domain/definitions.ts';
import type { RecordType, RelationName } from '../../src/domain/definitions.ts';
import type { Hash, Name } from '../../src/domain/ids.ts';
import type { BatchItem } from '../../src/domain/record.ts';
import { HexlogError } from '../../src/errors.ts';
import { verifyProcess } from '../../src/shared/loader.ts';
import type { Logger } from '../../src/shared/logger.ts';
import { at, createDataHome, rejectionOf } from '../helpers.ts';
import type { Manifest } from '../../src/domain/manifest.ts';
import type {
  AttachmentStatus,
  AttachmentStore,
  Decision,
  DefinitionKind,
  DefinitionOf,
  DefinitionStore,
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

/** Tipo com campos de anexo marcados e um campo livre que um hash pode vazar para ele. */
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

const DEFAULT_RELATIONS: RelationName[] = [
  { name: 'approves', kind: 'supports' },
  { name: 'replaces', kind: 'supersedes' },
  { name: 'only-tasks', kind: 'supports', from: ['task'] },
];

export function manifestOf(process: Name): Manifest {
  const fixed = {
    types: { note: NOTE, task: NOTE, doc: DOC },
    relations: Object.fromEntries(DEFAULT_RELATIONS.map((relation) => [relation.name, relation])),
    gates: {},
  };
  return {
    project: PROJECT,
    process,
    createdAt: NOW.toISOString(),
    fixed,
    hashes: {
      types: hashOfJcs(fixed.types),
      relations: hashOfJcs(fixed.relations),
      gates: hashOfJcs({}),
    },
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
  throw new Error('operation outside the scope of this spec');
};

function notFound(process: Name): HexlogError {
  const message = 'process not found';
  return new HexlogError('PROCESS_NOT_FOUND', message, [
    { path: '/process', code: 'not-found', message, process },
  ]);
}

function tooLarge(process: Name, advice = false): HexlogError {
  const base = `process '${process}' log exceeds 64 MiB`;
  const message = advice ? `${base}; create a new process to keep recording` : base;
  return new HexlogError('PROCESS_TOO_LARGE', message, [
    { path: '/process', code: 'too-large', message, process },
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
  const counters = {
    reads: [] as Name[],
    /** Manifestos recebidos por `create`, inclusive de processo que já existia. */
    creates: [] as Manifest[],
    writes: 0,
    appends: 0,
    syncsWithoutLine: 0,
  };

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
    if (flags.tooLarge.has(process)) throw tooLarge(process);
    return {
      manifest: structuredClone(manifest),
      text,
      endsWithNewline: text === '' || text.endsWith('\n'),
    };
  };

  const store: ProcessStore = {
    read: (ref) => rawOf(ref.process),
    readManifest: (ref) => structuredClone(manifestEntryOf(ref.process).manifest),
    list: refuse,
    listProjects: refuse,
    create: (ref, manifest) => {
      counters.creates.push(manifest);
      if (entries.has(ref.process)) return false;
      entries.set(ref.process, { manifest, text: '' });
      return true;
    },
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
      throw tooLarge(ref.process, true);
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
    add: (process: Name) => {
      entries.set(process, { manifest: manifestOf(process), text: '' });
    },
    readsOf: (process: Name) => counters.reads.filter((read) => read === process).length,
    /** O manifesto guardado, sem cópia, para provar que `create` não o reescreveu. */
    manifestStored: (process: Name) => entries.get(process)?.manifest,
    setManifest: (process: Name, manifest: Manifest) => {
      const entry = entries.get(process);
      if (entry !== undefined) entry.manifest = manifest;
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
function fakeAttachments() {
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

/**
 * `DefinitionStore` em memória com o contrato da porta: `write` devolve `false` se a versão já
 * existe. `racing` roda uma vez no início do próximo `write`, para plantar a versão de um escritor
 * concorrente; `reads` e `writes` registram as chamadas.
 */
export function fakeDefinitionStore() {
  const data: Record<DefinitionKind, Map<Name, Map<string, unknown>>> = {
    types: new Map(),
    relations: new Map(),
    gates: new Map(),
  };
  const reads: string[] = [];
  const writes: { kind: DefinitionKind; version: string }[] = [];
  let pending: (() => void) | undefined;

  /** Nome com a lista de versões vazia é a pasta que sobra de uma falha. */
  const slot = (kind: DefinitionKind, name: Name) => {
    const versions = data[kind].get(name) ?? new Map<string, unknown>();
    data[kind].set(name, versions);
    return versions;
  };
  const store: DefinitionStore = {
    names: (_project, kind) => [...data[kind].keys()],
    versions: (_project, kind, name) =>
      [...(data[kind].get(name)?.keys() ?? [])].sort(compareVersions),
    read: <K extends DefinitionKind>(_project: Name, kind: K, name: Name, version: string) => {
      reads.push(`${kind}/${name}@${version}`);
      return data[kind].get(name)?.get(version) as DefinitionOf[K];
    },
    write: (_project, kind, name, version, definition) => {
      writes.push({ kind, version });
      const plant = pending;
      pending = undefined;
      plant?.();
      const stored = slot(kind, name);
      if (stored.has(version)) return false;
      stored.set(version, structuredClone(definition));
      return true;
    },
  };

  return {
    store,
    reads,
    writes,
    add: <K extends DefinitionKind>(
      kind: K,
      name: Name,
      version: string,
      definition: DefinitionOf[K],
    ) => void slot(kind, name).set(version, structuredClone(definition)),
    addEmptyName: (kind: DefinitionKind, name: Name) => void slot(kind, name),
    stored: (kind: DefinitionKind, name: Name, version: string) =>
      data[kind].get(name)?.get(version),
    versions: (kind: DefinitionKind, name: Name) => store.versions(PROJECT, kind, name),
    racing: (plant: () => void) => void (pending = plant),
  };
}

/** Portas de `register` que um spec de `createProcess` não usa, só para completar as dependências. */
export const UNUSED_REGISTER_PORTS = {
  attachments: fakeAttachments().store,
  validator: createValidator(),
  newUuid: createUuids(),
  logger: () => undefined,
};

export function setup(newUuid: () => string = createUuids()) {
  const processes = fakeProcessStore();
  const attachments = fakeAttachments();
  const validator = createValidator();
  const validate = jest.spyOn(validator, 'validate');
  const logger = jest.fn<Logger>();
  let now = NOW;
  const service = createProcessService({
    store: processes.store,
    definitions: fakeDefinitionStore().store,
    attachments: attachments.store,
    validator,
    clock: () => now,
    newUuid,
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

/** Espera a rejeição de domínio e confere que ela não vaza pilha nem caminho de módulo. */
export const refusal = (promise: Promise<unknown>) => rejectionOf(promise, 'node_modules');

export const verifiedOf = (
  processes: ReturnType<typeof fakeProcessStore>,
  process: Name = ORIGIN,
) => verifyProcess(processes.store.read({ project: PROJECT, process }));

/** Id de registro bem formado de um processo que nunca recebeu o registro. */
export const ghostId = (process: Name, n = 999) => `${process}:00000000-0000-7000-8000-${HEX(n)}`;

/** `compose` real sobre `home`, sem log; o relógio padrão é fixo em `NOW`. */
export function composeIn(
  { xdg, dataDir }: { xdg: string; dataDir: string },
  clock: () => Date = () => NOW,
) {
  return compose({ dataDir, cwd: xdg, clock, logger: () => undefined }).services;
}

/**
 * `<xdg>/hexlog` com o tipo `note` e o processo `ref` criados pelo `compose` real; `register` grava
 * um registro com a `key` e devolve o id.
 */
export function seedNoteProcess(ref: ProcessRef = { project: PROJECT, process: ORIGIN }) {
  const home = createDataHome();
  const services = composeIn(home);
  services.definition.defineType({ project: ref.project, name: 'note', schema: NOTE });
  services.process.createProcess(ref);
  const register = async (key: string, item: BatchItem) => {
    const { records } = await services.process.register({
      ...ref,
      author: AUTHOR,
      key,
      records: [item],
    });
    return at(records, 0).id;
  };
  return { xdg: home.xdg, register };
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Roda `scripts/<script>.ts` num processo filho com `XDG_DATA_HOME=xdg` e devolve o código, o stdout e o stderr. */
export function runScript(script: string, xdg: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [`scripts/${script}.ts`, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
    timeout: 20_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
