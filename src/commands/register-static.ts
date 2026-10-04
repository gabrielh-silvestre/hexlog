import type { RecordType } from '../domain/definitions.ts';
import { processOf, type Name } from '../domain/ids.ts';
import {
  BATCH_MAX,
  type BatchItem,
  type RelationInput,
  type RelationKind,
} from '../domain/record.ts';
import { resolveKind, type NamedRelation } from '../domain/relations.ts';
import { HexlogError, invalidInput } from '../errors.ts';
import type { Manifest, Validator } from '../ports.ts';
import { invalidRecord, ruleRefusal } from './register-errors.ts';

/** Relação com o `kind` já resolvido; `input` é como o agente a enviou (`to` ainda pode ser `@alias`). */
export type PreparedRelation = { input: RelationInput; kind: RelationKind };

export type PreparedItem = { item: BatchItem; schema: RecordType; relations: PreparedRelation[] };

/** D-01: `to` de relação que cita um item anterior do mesmo lote. */
export const isAliasRef = (to: string): boolean => to.startsWith('@');

/** Posição de cada apelido no lote. */
export type AliasIndex = ReadonlyMap<Name, number>;

/**
 * D-06 nível 1: forma do lote (`INVALID_INPUT`): de 1 a 50 itens, apelidos únicos e `@alias` só para
 * item anterior. Só olha a entrada.
 */
export function checkBatchShape(records: readonly BatchItem[]): AliasIndex {
  if (records.length < 1 || records.length > BATCH_MAX) {
    throw invalidInput(
      '/records',
      'batch-size',
      `batch must have between 1 and ${BATCH_MAX} records`,
    );
  }
  const aliasIndex = new Map<Name, number>();
  for (const [index, { alias }] of records.entries()) {
    if (alias === undefined) continue;
    if (aliasIndex.has(alias)) {
      throw invalidInput(`/records/${index}/alias`, 'duplicate-alias', 'alias is already used');
    }
    aliasIndex.set(alias, index);
  }
  for (const [index, { relations = [] }] of records.entries()) {
    for (const [at, { to }] of relations.entries()) {
      if (!isAliasRef(to)) continue;
      const path = `/records/${index}/relations/${at}/to`;
      const target = aliasIndex.get(to.slice(1));
      if (target === undefined) throw invalidInput(path, 'unknown-alias', 'no such alias in batch');
      if (target >= index) {
        throw invalidInput(path, 'forward-alias', 'alias must name an earlier record of the batch');
      }
    }
  }
  return aliasIndex;
}

/** Nomes de relação fixados no processo, no formato que `domain/relations.ts` espera. */
export function relationNames(manifest: Manifest): ReadonlyMap<Name, NamedRelation> {
  return new Map(Object.entries(manifest.fixed.relations));
}

function pinnedSchema(manifest: Manifest, item: BatchItem, index: number): RecordType {
  const { types } = manifest.fixed;
  const schema = Object.hasOwn(types, item.type) ? types[item.type] : undefined;
  if (schema !== undefined) return schema;
  const message = `type '${item.type}' is not pinned in the process`;
  throw new HexlogError('TYPE_NOT_PINNED', message, [
    { path: `/records/${index}/type`, code: 'not-pinned', message },
  ]);
}

/**
 * `Validator.validate` devolve um erro por subschema avaliado de UM registro (com `path` relativo a
 * `data`; em `anyOf`/`oneOf`/`propertyNames` saem os dos ramos). O lote não os agrega: recusa no
 * primeiro item inválido, então a resposta traz só os detalhes dele, não os de cada item. O agente
 * corrige e reenvia; o `path` sai refeito para `/records/<i>/data/...`.
 */
function checkData(validator: Validator, schema: RecordType, item: BatchItem, index: number): void {
  const details = validator.validate(schema, item.data);
  if (details.length === 0) return;
  throw invalidRecord(
    details.map((detail) => ({ ...detail, path: `/records/${index}/data${detail.path}` })),
  );
}

function resolveRelations(
  item: BatchItem,
  index: number,
  names: ReadonlyMap<Name, NamedRelation>,
): PreparedRelation[] {
  return (item.relations ?? []).map((relation, at) => {
    // O refine de `RelationInput` garante `kind` ou `as`; o tipo inferido de `BatchItem` não o carrega.
    const input = relation as RelationInput;
    const check = resolveKind(input, names);
    if ('violation' in check) {
      throw ruleRefusal(`/records/${index}/relations/${at}`, check.violation);
    }
    return { input, kind: check.kind };
  });
}

/** `supersedes` e `revokes` só valem no processo de origem; item do lote (`@alias`) já é dele. */
function checkCurrencyScope(prepared: readonly PreparedItem[], origin: Name): void {
  for (const [index, { relations }] of prepared.entries()) {
    for (const [at, { input, kind }] of relations.entries()) {
      const crosses = !isAliasRef(input.to) && processOf(input.to) !== origin;
      if (crosses && (kind === 'supersedes' || kind === 'revokes')) {
        throw ruleRefusal(`/records/${index}/relations/${at}`, { code: 'cross-process-currency' });
      }
    }
  }
}

/**
 * D-06 nível 3: recusas que só dependem da entrada e do manifesto (imutável), então a chamada
 * original e o reenvio de mesma impressão recebem a mesma resposta. Uma passada por regra, na ordem
 * de D-06: tipo fixado e schema, `as`→`kind`, `cross-process-currency`.
 */
export function prepareBatch(
  manifest: Manifest,
  records: readonly BatchItem[],
  validator: Validator,
): PreparedItem[] {
  const names = relationNames(manifest);
  const valid = records.map((item, index) => {
    const schema = pinnedSchema(manifest, item, index);
    checkData(validator, schema, item, index);
    return { item, schema };
  });
  const prepared = valid.map(({ item, schema }, index) => ({
    item,
    schema,
    relations: resolveRelations(item, index, names),
  }));
  checkCurrencyScope(prepared, manifest.process);
  return prepared;
}
