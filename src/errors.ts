import type { z } from 'zod';
import type { RecordId } from './domain/ids.ts';

/**
 * Um item do array `details` de `HexlogError` (§4.13): aponta o campo problemático via JSON Pointer.
 * `owners`/`allowed` são específicos de `VOCABULARY_VIOLATED` (P2): contexto opcional, não usado
 * pelos demais erros. `current`, `process` e `pid` são da 1.0 (D-26): versão vigente da linhagem
 * (`null` se revogada), processo citado e pid do detentor do lock.
 */
export type Detail = {
  path: string;
  code: string;
  message: string;
  owners?: string[];
  allowed?: string[];
  current?: RecordId | null;
  process?: string;
  pid?: number;
};

/**
 * Catálogo de códigos de erro de domínio (§4.13). Na transição a união é aditiva: os códigos da 1.0
 * convivem com os legados, que saem no corte.
 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_FILTER'
  | 'RESERVED_NAME'
  | 'INVALID_SCHEMA'
  | 'PROJECT_NOT_FOUND'
  | 'PROCESS_NOT_FOUND'
  | 'TYPE_NOT_FOUND'
  | 'VOCABULARY_MISSING'
  | 'PROCESS_CORRUPTED'
  | 'INVALID_ID'
  | 'UNKNOWN_ID'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_CORRUPTED'
  | 'CONFLICTING_ID'
  | 'TYPE_NOT_PINNED'
  | 'INVALID_EVENT'
  | 'RESERVED_FIELD'
  | 'VOCABULARY_VIOLATED'
  | 'GATE_NOT_REGISTERED'
  | 'INVALID_EVALUATION'
  | 'LOCK_TIMEOUT'
  | 'LOCK_LOST'
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

/** JSON Pointer (RFC 6901) de um `path` do Zod, escapando `~` e `/` na ordem correta. */
function pointer(path: PropertyKey[]): string {
  return path
    .map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`)
    .join('');
}

/** Converte `issues` do Zod em `details[]`, prefixando o ponteiro (ex.: `/dados`). */
export function issueDetails(issues: z.core.$ZodIssue[], prefix: string): Detail[] {
  return issues.map((issue) => ({
    path: prefix + pointer(issue.path),
    code: issue.code,
    message: issue.message,
  }));
}
