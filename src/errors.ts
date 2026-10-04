import { uniqBy } from 'es-toolkit';
import type { z } from 'zod';
import type { RecordId } from './domain/ids.ts';

/**
 * Um item do array `details` de `HexlogError` (§4.13): aponta o campo problemático via JSON Pointer.
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

/** Catálogo de códigos de erro de domínio (§4.13): a união literal única de 25 códigos. */
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

/** Erro de domínio do hexlog: todo handler MCP captura este tipo e devolve `{code, message, details}` (§4.13). */
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

/** `INVALID_INPUT` com um único `Detail` em `path`; `message` é a do erro e a do `Detail`. */
export function invalidInput(path: string, code: string, message: string): HexlogError {
  return new HexlogError('INVALID_INPUT', message, [{ path, code, message }]);
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
