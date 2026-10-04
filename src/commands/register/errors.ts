import type { RuleCode, Violation } from '../../domain/relations.ts';
import { HexlogError, type Detail } from '../../errors.ts';

export function invalidRecord(details: Detail[]): HexlogError {
  return new HexlogError('INVALID_RECORD', 'record violates a type or relation rule', details);
}

const RULE_MESSAGES: Record<RuleCode, string> = {
  'self-relation': 'a record cannot relate to itself',
  'unknown-relation-name': 'relation name is not pinned in the process',
  'kind-mismatch': 'kind does not match the kind of the pinned relation name',
  'cross-process-currency': 'supersedes and revokes only target records of the same process',
  'type-mismatch': 'supersedes only targets a record of the same type',
  'endpoint-type': 'record type is not allowed at this end of the relation name',
  'supports-and-contradicts': 'a record cannot both support and contradict the same destination',
  'supersedes-and-revokes': 'a record cannot both supersede and revoke the same destination',
  'not-current': 'destination is not current; supersede or revoke the current version',
  'stale-destination': 'supports only targets a current record',
};

/**
 * D-10/D-26: violação de regra estrutural no `path` da relação. `not-current` é `FORK_REJECTED`; as
 * demais, `INVALID_RECORD`. `current` (versão atual da linhagem, ou `null`) só sai quando a regra o traz.
 */
export function ruleRefusal(path: string, { code, current }: Violation): HexlogError {
  const message = RULE_MESSAGES[code];
  const detail: Detail = { path, code, message, ...(current !== undefined && { current }) };
  if (code === 'not-current') return new HexlogError('FORK_REJECTED', message, [detail]);
  return invalidRecord([detail]);
}

export function relationNotFound(
  path: string,
  code: 'missing' | 'destination-corrupted',
  process?: string,
): HexlogError {
  const message =
    code === 'missing' ? 'relation destination not found' : 'relation destination is corrupted';
  const detail: Detail = { path, code, message, ...(process !== undefined && { process }) };
  return new HexlogError('RELATION_NOT_FOUND', message, [detail]);
}

/**
 * As portas apontam o campo da tool que presumem (`/process`, `/hash`...) ou nenhum (`IO_ERROR`).
 * Quando o valor veio de `records[i]`, o serviço refaz o `path` de qualquer erro de porta para o
 * campo certo do lote e, se o erro é de outro processo que o da chamada, `process` o nomeia.
 */
export function withPath(error: unknown, path: string, process?: string): unknown {
  if (!(error instanceof HexlogError)) return error;
  return new HexlogError(
    error.code,
    error.message,
    error.details.map((detail) => ({ ...detail, path, ...(process !== undefined && { process }) })),
  );
}
