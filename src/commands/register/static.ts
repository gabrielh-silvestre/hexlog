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
import { endsVigency, resolveKind, type NamedRelation } from '../../domain/relations.ts';
import {
  capDetails,
  invalidInput,
  invalidRecord,
  typeNotPinned,
  VIOLATIONS_CAPPED_CODE,
  violationsCapped,
  type Detail,
} from '../../errors.ts';
import type { Validator } from '../../ports.ts';
import { ruleDetail } from './errors.ts';

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
  throw typeNotPinned(item.type, `/records/${index}/type`);
}

/**
 * Violações de schema de UM registro, com o `path` refeito para `/records/<i>/data/...`. O
 * `validate` devolve todas as violações do registro (em `anyOf`/`oneOf`/`propertyNames` saem as dos
 * ramos), cada uma com o valor medido quando é de tamanho. O aviso `violations-capped` do
 * validador, que não conhece o registro, é refeito aqui com o nome do tipo.
 */
function checkData(
  validator: Validator,
  schema: RecordType,
  item: BatchItem,
  index: number,
): Detail[] {
  const at = `/records/${index}/data`;
  return validator
    .validate(schema, item.data)
    .map((detail) =>
      detail.code === VIOLATIONS_CAPPED_CODE
        ? violationsCapped(at + detail.path, item.type)
        : { ...detail, path: at + detail.path },
    );
}

/**
 * Relações de UM registro com o `kind` resolvido, mais a violação de cada relação que não resolve
 * (`as` desconhecido, `kind` divergente) ou que cruza processo com `supersedes`/`revokes` (item do
 * lote, `@alias`, já é do processo de origem): no máximo um `Detail` por relação.
 */
function prepareRelations(
  item: BatchItem,
  index: number,
  names: ReadonlyMap<Name, NamedRelation>,
  origin: Name,
): { relations: PreparedRelation[]; violations: Detail[] } {
  const relations: PreparedRelation[] = [];
  const violations: Detail[] = [];
  for (const [at, relation] of (item.relations ?? []).entries()) {
    // O refine de `RelationInput` garante `kind` ou `as`; o tipo inferido de `BatchItem` não o carrega.
    const input = relation as RelationInput;
    const path = `/records/${index}/relations/${at}`;
    const check = resolveKind(input, names);
    if ('violation' in check) {
      violations.push(ruleDetail(path, check.violation));
    } else if (!isAliasRef(input.to) && processOf(input.to) !== origin && endsVigency(check.kind)) {
      violations.push(ruleDetail(path, { code: 'cross-process-currency' }));
    } else {
      relations.push({ input, kind: check.kind });
    }
  }
  return { relations, violations };
}

/**
 * D-06 nível 3: recusas que só dependem da entrada e do manifesto (imutável), então a chamada
 * original e o reenvio de mesma impressão recebem a mesma resposta. O tipo fixado de todos os
 * registros vem primeiro e recusa no primeiro erro (`TYPE_NOT_PINNED` vence o `INVALID_RECORD`);
 * depois as violações estáticas saem juntas num só `INVALID_RECORD`, nesta ordem: o schema de todos
 * os registros e, por (registro, relação), `as`→`kind` e `cross-process-currency`, sob o teto de
 * `capDetails`. O que depende do estado do log (`not-current` e as regras de `state.ts`) segue
 * recusando no primeiro erro, sob o lock.
 *
 * Roda antes do lock (`commands/process.ts#register` a chama antes de `store.write`; só o `decide`
 * roda sob o lock, síncrono), então a compilação do schema não alonga a seção crítica. Tudo-ou-nada.
 */
export function prepareBatch(
  manifest: Manifest,
  names: ReadonlyMap<Name, NamedRelation>,
  records: readonly BatchItem[],
  validator: Validator,
): PreparedItem[] {
  const schemas = records.map((item, index) => pinnedSchema(manifest, item, index));
  const dataViolations = records.flatMap((item, index) =>
    checkData(validator, schemas[index]!, item, index),
  );
  const resolved = records.map((item, index) =>
    prepareRelations(item, index, names, manifest.process),
  );
  const violations = [...dataViolations, ...resolved.flatMap(({ violations }) => violations)];
  if (violations.length > 0) throw invalidRecord(capDetails(violations));
  return records.map((item, index) => ({
    item,
    schema: schemas[index]!,
    relations: resolved[index]!.relations,
  }));
}
