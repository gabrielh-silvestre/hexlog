import { isUndefined, omitBy } from 'es-toolkit';
import type { RuleCode, Violation } from '../../domain/relations.ts';
import { domainError, type HexlogError, invalidRecord } from '../../errors.ts';

const RULE_MESSAGES: Record<RuleCode, string> = {
  'self-relation': 'a record cannot relate to itself',
  'unknown-relation-name': 'relation name is not pinned in the process',
  'kind-mismatch': 'kind does not match the kind of the pinned relation name',
  'cross-process-currency': 'supersedes and revokes only target records of the same process',
  'type-mismatch': 'supersedes only targets a record of the same type',
  'target-mismatch':
    'supersedes only targets a record of the same target; to move a fact to another target, register one record at the right target with revokes and derivesFrom to the old one',
  'endpoint-type': 'record type is not allowed at this end of the relation name',
  'supports-and-contradicts': 'a record cannot both support and contradict the same destination',
  'supersedes-and-revokes': 'a record cannot both supersede and revoke the same destination',
  'not-current': 'destination is not current; supersede or revoke the current version',
  'stale-destination': 'supports only targets a current record',
};

/**
 * D-10/D-26: violação de regra estrutural no `path` da relação. `not-current` é `FORK_REJECTED`; as
 * demais, `INVALID_RECORD`. `current` (versão atual da linhagem, ou `null`) e `kind` (o do nome
 * fixado, em `kind-mismatch`) só saem quando a regra os traz.
 */
export function ruleRefusal(path: string, { code, current, kind }: Violation): HexlogError {
  const message =
    code === 'kind-mismatch' && !isUndefined(kind)
      ? `${RULE_MESSAGES[code]}; send as alone, or kind "${kind}"`
      : RULE_MESSAGES[code];
  if (code === 'not-current') return domainError('FORK_REJECTED', path, code, message, { current });
  return invalidRecord([{ path, code, message, ...omitBy({ current, kind }, isUndefined) }]);
}
