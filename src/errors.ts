import { isUndefined, omitBy, uniqBy } from 'es-toolkit';
import type { z } from 'zod';
import type { Name, RecordId } from './domain/ids.ts';

/**
 * Um item do array `details` de `HexlogError` (ADR 0009 item 11): aponta o campo problemático via
 * JSON Pointer.
 * `current`, `process` e `pid` são da 1.0 (D-26): versão vigente da linhagem (`null` se revogada),
 * processo citado e pid do detentor do lock. `versions` é das definições: as versões que existem
 * quando a pedida não existe.
 */
export type Detail = {
  path: string;
  code: string;
  message: string;
  current?: RecordId | null;
  process?: string;
  pid?: number;
  versions?: string[];
};

/** Catálogo de códigos de erro de domínio (ADR 0009 item 7): a união literal única. */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_FILTER'
  | 'RESERVED_NAME'
  | 'INVALID_SCHEMA'
  | 'PROJECT_NOT_FOUND'
  | 'PROCESS_NOT_FOUND'
  | 'TYPE_NOT_FOUND'
  | 'PROCESS_CORRUPTED'
  | 'PROCESS_TOO_LARGE'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_CORRUPTED'
  | 'TYPE_NOT_PINNED'
  | 'LOCK_TIMEOUT'
  | 'IO_ERROR'
  | 'INTERNAL'
  | 'BREAKING_CHANGE'
  | 'INVALID_RECORD'
  | 'GATE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'LEGACY_DATA'
  | 'INVALID_CURSOR'
  | 'MARKER_NOT_FOUND'
  | 'FORK_REJECTED'
  | 'CYCLE_REJECTED'
  | 'RELATION_NOT_FOUND';

/**
 * Erro de domínio do hexlog: todo handler MCP captura este tipo e devolve `{code, message, details}`
 * (ADR 0009 item 11).
 */
export class HexlogError extends Error {
  readonly code: ErrorCode;
  readonly details: Detail[];

  constructor(code: ErrorCode, message: string, details: Detail[] = []) {
    super(message);
    this.name = 'HexlogError';
    this.code = code;
    this.details = details;
  }
}

/** Campos opcionais de um `Detail` que só alguns erros trazem. */
type DetailExtra = Pick<Detail, 'current' | 'process' | 'pid' | 'versions'>;

/**
 * Erro com um único `Detail`; `message` é a do erro e a do `Detail`. As chaves `undefined` de `extra`
 * somem (`null` fica) e vêm depois de `message`, na ordem em que o chamador as passa.
 */
export function domainError(
  code: ErrorCode,
  path: string,
  detailCode: string,
  message: string,
  extra?: DetailExtra,
): HexlogError {
  return new HexlogError(code, message, [
    { path, code: detailCode, message, ...omitBy(extra ?? {}, isUndefined) },
  ]);
}

/** `INTERNAL` sem `Detail`: o erro de quem não aponta campo nenhum (`details` fica `[]`). */
export function internalError(message: string): HexlogError {
  return new HexlogError('INTERNAL', message);
}

/** `INVALID_INPUT` com um único `Detail` em `path`; `message` é a do erro e a do `Detail`. */
export function invalidInput(path: string, code: string, message: string): HexlogError {
  return domainError('INVALID_INPUT', path, code, message);
}

/**
 * Cadeia do processo quebrada (`PROCESS_CORRUPTED`, `broken-chain`, `details[0].process`): a mesma
 * para a leitura (`queries/`) e para a escrita (`commands/`), que não podem se importar.
 */
export function brokenChain(process: Name): HexlogError {
  return domainError('PROCESS_CORRUPTED', '/process', 'broken-chain', 'process chain is broken', {
    process,
  });
}

/** `RESERVED_NAME` de nome de processo reservado (`domain/ids.ts#isReservedProcessName`): a mesma para o serviço e o adaptador. */
export function reservedName(): HexlogError {
  return domainError('RESERVED_NAME', '/process', 'reserved-name', 'reserved process name');
}

/** Comando de arquivamento que `LEGACY_DATA` devolve em `details` (D-13): sem caminho absoluto. */
const ARCHIVE_COMMAND = 'node scripts/install.ts --archive-0x (from the hexlog repository)';

/** Recusa de dado 0.x em `<D>` (D-13): a mesma para o kernel MCP e para os scripts de leitura (P11). */
export function legacyDataError(): HexlogError {
  return new HexlogError('LEGACY_DATA', 'legacy 0.x data found; archive it first', [
    { path: '', code: 'run', message: ARCHIVE_COMMAND },
  ]);
}

/** JSON Pointer (RFC 6901) de um `path` do Zod, escapando `~` e `/` na ordem correta. */
export function pointer(path: PropertyKey[]): string {
  return path
    .map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`)
    .join('');
}

/** Alinhado a `BATCH_MAX` (`docs/tetos-dominio-v1.md`); sem medição por trás. */
const MAX_DETAILS = 50;

/**
 * Deduplica por path+code+message (o ajv repete o mesmo erro, pois o metaschema é revisitado por
 * `$dynamicRef`) e corta em `MAX_DETAILS`, avisando no último `Detail` quantos ficaram de fora.
 */
export function capDetails(details: Detail[]): Detail[] {
  const unique = uniqBy(details, (d) => `${d.path}\0${d.code}\0${d.message}`);
  if (unique.length <= MAX_DETAILS) return unique;
  return [
    ...unique.slice(0, MAX_DETAILS),
    {
      path: '',
      code: 'too-many-errors',
      message: `${unique.length - MAX_DETAILS} more errors omitted`,
    },
  ];
}

/** Converte `issues` do Zod em `details[]`, prefixando o ponteiro (ex.: `/dados`); no máximo `MAX_DETAILS`. */
export function issueDetails(issues: z.core.$ZodIssue[], prefix: string): Detail[] {
  return capDetails(
    issues.map((issue) => ({
      path: prefix + pointer(issue.path),
      code: issue.code,
      message: issue.message,
    })),
  );
}

/** Erro do Zod com mensagem própria: os `details` vêm de `issueDetails`, com `prefix` no ponteiro. */
export function fromIssues(
  code: ErrorCode,
  message: string,
  issues: z.core.$ZodIssue[],
  prefix: string,
): HexlogError {
  return new HexlogError(code, message, issueDetails(issues, prefix));
}

/** Refaz o erro com cada `Detail` passado por `fn`; código e mensagem ficam. */
export function mapDetails(error: HexlogError, fn: (detail: Detail) => Detail): HexlogError {
  return new HexlogError(error.code, error.message, error.details.map(fn));
}

/** Erro com uma lista de `details` já pronta (a de um validador), cada `path` prefixado com `prefix`. */
export function fromDetails(
  code: ErrorCode,
  message: string,
  details: Detail[],
  prefix = '',
): HexlogError {
  return new HexlogError(
    code,
    message,
    details.map((detail) => ({ ...detail, path: prefix + detail.path })),
  );
}

/** `INVALID_INPUT` de entrada que não passa pelo esquema da tool: a mensagem é sempre `invalid input`. */
export function invalidArgs(details: Detail[]): HexlogError {
  return new HexlogError('INVALID_INPUT', 'invalid input', details);
}

/** `INVALID_RECORD` de lote: um registro viola regra de tipo ou de relação. */
export function invalidRecord(details: Detail[]): HexlogError {
  return new HexlogError('INVALID_RECORD', 'record violates a type or relation rule', details);
}

/**
 * As portas apontam o campo da tool que presumem (`/process`, `/hash`...) ou nenhum (`IO_ERROR`).
 * Quando o valor veio de `records[i]`, o serviço refaz o `path` de qualquer erro de porta para o
 * campo certo do lote e, se o erro é de outro processo que o da chamada, `process` o nomeia.
 */
export function withPath(error: unknown, path: string, process?: string): unknown {
  if (!(error instanceof HexlogError)) return error;
  return mapDetails(error, (detail) => ({ ...detail, path, ...omitBy({ process }, isUndefined) }));
}

/** `IO_ERROR` só com o errno em minúsculas: a `message` do fs carrega o caminho absoluto (D-26). */
export function ioError(errno: string): HexlogError {
  return domainError('IO_ERROR', '', errno, 'I/O failure');
}

/** `LOCK_TIMEOUT` em `/process`; `pid` é o do detentor, quando se sabe. */
export function lockTimeout(
  code: 'lock-busy' | 'lock-lost' | 'holder-unreadable',
  message: string,
  pid?: number,
): HexlogError {
  return domainError('LOCK_TIMEOUT', '/process', code, message, { pid });
}

/** `path` é o campo que a porta presume (`/hash`) ou o de `records[i]` onde o hash foi citado. */
export function attachmentNotFound(path: string, hash: string): HexlogError {
  return domainError('ATTACHMENT_NOT_FOUND', path, 'not-found', `attachment '${hash}' not found`);
}

export function attachmentCorrupted(path: string, hash: string): HexlogError {
  return domainError(
    'ATTACHMENT_CORRUPTED',
    path,
    'corrupted',
    `attachment '${hash}' does not match its hash`,
  );
}

export function outsideAllowedRoot(): HexlogError {
  return invalidInput('/path', 'outside-allowed-root', 'path is outside the allowed root');
}

/** `grewWhileReading`: o arquivo cresceu depois do `fstat`; o código segue `too-big`, só a mensagem muda. */
export function tooBigFile(maxBytes: number, grewWhileReading = false): HexlogError {
  const message = grewWhileReading
    ? 'file changed while being read'
    : `file exceeds ${maxBytes} bytes`;
  return invalidInput('/path', 'too-big', message);
}

export function processNotFound(process: Name): HexlogError {
  return domainError('PROCESS_NOT_FOUND', '/process', 'not-found', 'process not found', {
    process,
  });
}

export function unreadableManifest(process: Name): HexlogError {
  return domainError(
    'PROCESS_CORRUPTED',
    '/process',
    'unreadable-manifest',
    'process manifest is unreadable',
    { process },
  );
}

/** A recomendação de criar outro processo só vale para quem grava: leitura e destino de relação ficam neutros. */
export function processTooLarge(process: Name, limitBytes: number, advice = false): HexlogError {
  const base = `process '${process}' log exceeds ${limitBytes / 2 ** 20} MiB`;
  const message = advice ? `${base}; create a new process to keep recording` : base;
  return domainError('PROCESS_TOO_LARGE', '/process', 'too-large', message, { process });
}

/**
 * Definição ausente: com a lista `existing` vazia, o nome não tem nenhuma versão (pasta inexistente
 * ou vazia: `unknown-name`); com versões, o nome existe e a pedida não (`unknown-version`,
 * listando as que existem, nunca vazia). `code` é o `*_NOT_FOUND` do tipo de definição.
 */
export function definitionNotFound(code: ErrorCode, existing: string[]): HexlogError {
  if (existing.length === 0) {
    return domainError(code, '/name', 'unknown-name', 'definition name not found');
  }
  return domainError(code, '/version', 'unknown-version', 'definition version not found', {
    versions: existing,
  });
}

export function unreadableDefinition(): HexlogError {
  return domainError(
    'INTERNAL',
    '/version',
    'unreadable-definition',
    'definition file is unreadable',
  );
}

/** Definição que o próprio `read` recusaria: gravá-la envenenaria uma versão imutável. */
export function invalidDefinition(): HexlogError {
  return domainError(
    'INTERNAL',
    '/definition',
    'invalid-definition',
    'definition does not match its schema',
  );
}

export function projectNotFound(): HexlogError {
  return domainError('PROJECT_NOT_FOUND', '/project', 'unknown-project', 'project not found');
}

/** O campo da entrada é `/type`, diferente do `/name` que a leitura de definição aponta. */
export function typeNotFound(): HexlogError {
  return domainError('TYPE_NOT_FOUND', '/type', 'unknown-name', 'type not found in the project');
}

export function gateNotFound(): HexlogError {
  return domainError(
    'GATE_NOT_FOUND',
    '/gate',
    'unknown-name',
    'gate is not pinned in the process',
  );
}

/** `INVALID_FILTER` com um único `Detail`; a `message` do erro é fixa, a do `Detail` é a de quem recusa. */
export function invalidFilter(path: string, code: string, message: string): HexlogError {
  return new HexlogError('INVALID_FILTER', 'Invalid filter', [{ path, code, message }]);
}

/** `path` é o campo da entrada (`/type`) ou o do `records[i]` onde o tipo foi citado. */
export function typeNotPinned(type: string, path = '/type'): HexlogError {
  return domainError(
    'TYPE_NOT_PINNED',
    path,
    'not-pinned',
    `type '${type}' is not pinned in the process`,
  );
}

export function markerNotFound(): HexlogError {
  return domainError(
    'MARKER_NOT_FOUND',
    '/marker',
    'marker-not-found',
    'marker record not found in process',
  );
}

export function markerProcessNotFound(
  process: Name,
  message = 'marker names a process that does not exist',
): HexlogError {
  return domainError('MARKER_NOT_FOUND', '/marker', 'process-not-found', message, { process });
}

const RERUN_ADVICE = '; rerun the query without cursor';

/** `INVALID_CURSOR` com um único `Detail` em `/cursor`; toda mensagem manda reexecutar sem cursor. */
export function invalidCursor(code: string, message: string): HexlogError {
  return new HexlogError('INVALID_CURSOR', 'Invalid cursor', [
    { path: '/cursor', code, message: message + RERUN_ADVICE },
  ]);
}

/** `INVALID_CURSOR` de payload que não passa pelo esquema do cursor, um `Detail` por issue do Zod. */
export function invalidCursorPayload(issues: z.core.$ZodIssue[]): HexlogError {
  return new HexlogError(
    'INVALID_CURSOR',
    'Invalid cursor',
    issueDetails(issues, '/cursor').map((detail) => ({
      ...detail,
      message: detail.message + RERUN_ADVICE,
    })),
  );
}

export function relationNotFound(
  path: string,
  code: 'missing' | 'destination-corrupted',
  process?: string,
): HexlogError {
  const message =
    code === 'missing' ? 'relation destination not found' : 'relation destination is corrupted';
  return domainError('RELATION_NOT_FOUND', path, code, message, { process });
}

export function cycleRejected(): HexlogError {
  return domainError('CYCLE_REJECTED', '', 'cycle', 'batch would create a supersedes cycle');
}
