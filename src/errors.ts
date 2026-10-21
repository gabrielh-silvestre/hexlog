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
