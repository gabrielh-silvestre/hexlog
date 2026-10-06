import { isUndefined } from 'es-toolkit';
import type { RecordType } from '../../domain/definitions.ts';
import { processOf, type Name } from '../../domain/ids.ts';
import type { Manifest } from '../../domain/manifest.ts';
import {
  BATCH_MAX,
  type BatchItem,
  type RelationInput,
  type RelationKind,
} from '../../domain/record.ts';
import { resolveKind, type NamedRelation } from '../../domain/relations.ts';
import { capDetails, HexlogError, invalidInput, type Detail } from '../../errors.ts';
import type { Validator } from '../../ports.ts';
import { invalidRecord, ruleRefusal } from './errors.ts';

/** Relação com o `kind` já resolvido; `input` é como o agente a enviou (`to` ainda pode ser `@alias`). */
type PreparedRelation = { input: RelationInput; kind: RelationKind };

export type PreparedItem = { item: BatchItem; schema: RecordType; relations: PreparedRelation[] };

/** D-01: `to` de relação que cita um item anterior do mesmo lote. */
export const isAliasRef = (to: string): boolean => to.startsWith('@');

/**
 * D-06 nível 1: forma do lote (`INVALID_INPUT`): de 1 a 50 itens, apelidos únicos e `@alias` só para
 * item anterior. Só olha a entrada.
 */
export function checkBatchShape(records: readonly BatchItem[]): void {
  if (records.length < 1 || records.length > BATCH_MAX) {
    throw invalidInput(
      '/records',
      'batch-size',
      `batch must have between 1 and ${BATCH_MAX} records`,
    );
  }
  const aliasIndex = new Map<Name, number>();
  for (const [index, { alias }] of records.entries()) {
    if (isUndefined(alias)) continue;
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
      if (isUndefined(target)) throw invalidInput(path, 'unknown-alias', 'no such alias in batch');
      if (target >= index) {
        throw invalidInput(path, 'forward-alias', 'alias must name an earlier record of the batch');
      }
    }
  }
}

/** Nomes de relação fixados no processo, no formato que `domain/relations.ts` espera. */
export function relationNames(manifest: Manifest): ReadonlyMap<Name, NamedRelation> {
  return new Map(Object.entries(manifest.fixed.relations));
}

function pinnedSchema(manifest: Manifest, item: BatchItem, index: number): RecordType {
  const { types } = manifest.fixed;
  const schema = Object.hasOwn(types, item.type) ? types[item.type] : undefined;
  if (!isUndefined(schema)) return schema;
  const message = `type '${item.type}' is not pinned in the process`;
  throw new HexlogError('TYPE_NOT_PINNED', message, [
    { path: `/records/${index}/type`, code: 'not-pinned', message },
  ]);
}

/**
 * Violações de schema de UM registro, com o `path` refeito para `/records/<i>/data/...`. O
 * `validate` para no primeiro erro de cada subschema; só quando falha o `report` junta o resto, e
 * ele substitui os detalhes do `validate` (que ficam só se o relatório vier vazio, para nunca haver
 * `INVALID_RECORD` sem detalhe).
 */
function checkData(
  validator: Validator,
  schema: RecordType,
  item: BatchItem,
  index: number,
): Detail[] {
  const first = validator.validate(schema, item.data);
  if (first.length === 0) return [];
  const report = validator.report(schema, item.data);
  return (report.length === 0 ? first : report).map((detail) => ({
    ...detail,
    path: `/records/${index}/data${detail.path}`,
  }));
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
 * de D-06: tipo fixado de todos os registros, schema de todos, `as`→`kind`, `cross-process-currency`.
 *
 * Roda antes do lock (`commands/process.ts#register` a chama antes de `store.write`; só o `decide`
 * roda sob o lock, síncrono), então a compilação do relatório de schema não alonga a seção crítica.
 * O tipo fixado vem antes do dado: `TYPE_NOT_PINNED` de qualquer registro vence o `INVALID_RECORD`
 * de dado de um anterior. A agregação cobre só a violação de schema (as de todos os registros, com
 * o teto de `capDetails`); as demais regras seguem recusando no primeiro erro. Tudo-ou-nada.
 */
export function prepareBatch(
  manifest: Manifest,
  names: ReadonlyMap<Name, NamedRelation>,
  records: readonly BatchItem[],
  validator: Validator,
): PreparedItem[] {
  const schemas = records.map((item, index) => pinnedSchema(manifest, item, index));
  const violations = records.flatMap((item, index) =>
    checkData(validator, schemas[index]!, item, index),
  );
  if (violations.length > 0) throw invalidRecord(capDetails(violations));
  const prepared = records.map((item, index) => ({
    item,
    schema: schemas[index]!,
    relations: resolveRelations(item, index, names),
  }));
  checkCurrencyScope(prepared, manifest.process);
  return prepared;
}
