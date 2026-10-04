import { memoize, once } from 'es-toolkit';
import { hashLink, type Batch, type Link } from '../../domain/chain.ts';
import { processOf, type Hash, type Name, type RecordId } from '../../domain/ids.ts';
import type { BatchItem, Relation, RelationInput } from '../../domain/record.ts';
import {
  buildVigency,
  checkRelation,
  hasCycle,
  type Linked,
  type NamedRelation,
  type RelationEnd,
  type RuleContext,
  type Vigency,
} from '../../domain/relations.ts';
import { brokenChain, HexlogError } from '../../errors.ts';
import type {
  AttachmentStore,
  Decision,
  ProcessRef,
  ProcessStore,
  RawProcess,
} from '../../ports.ts';
import {
  formatLine,
  isValidLine,
  loadVerified,
  verifyProcess,
  type BatchEntry,
  type VerifiedProcess,
} from '../../shared/loader.ts';
import { checkAttachments } from './attachments.ts';
import { relationNotFound, ruleRefusal, withPath } from './errors.ts';
import { isAliasRef, type PreparedItem } from './static.ts';
import type { RegisteredRecord, RegisterInput, RegisterResult } from './types.ts';

type DecideDeps = {
  store: Pick<ProcessStore, 'read'>;
  attachments: AttachmentStore;
  clock: () => Date;
  newUuid: () => string;
};

/** O que `decide` sabe da chamada, já com o que as checagens estáticas resolveram. */
type DecideCall = Pick<RegisterInput, 'project' | 'process' | 'author' | 'key'> & {
  fingerprint: Hash;
  items: readonly PreparedItem[];
  names: ReadonlyMap<Name, NamedRelation>;
};

type DraftRelation = { stored: Relation; input: RelationInput };

/** Item do lote com id atribuído e relações resolvidas: `to` já é um id, `kind` sempre preenchido. */
type Draft = { id: RecordId; item: BatchItem; relations: DraftRelation[] };

/** Os itens do lote com id, e o mapa apelido para id deles. */
type Drafted = { drafts: Draft[]; aliases: Record<Name, RecordId> };

/** Uma relação de um item do lote, com a posição que os `path` de erro apontam. */
type Site = { index: number; at: number; draft: Draft; relation: DraftRelation };

/** Registros de um processo-destino que as relações podem citar, e a vigência deles. */
type Destination = { types: ReadonlyMap<RecordId, Name>; vigency: Vigency };

/** D-06 nível 5: a mesma `key` com outra impressão é conflito; com a mesma, o chamador faz o replay. */
function assertSameBatch(prior: BatchEntry, fingerprint: Hash): void {
  if (prior.fingerprint === fingerprint) return;
  const message = 'key was already used with a different batch';
  throw new HexlogError('IDEMPOTENCY_CONFLICT', message, [
    { path: '/key', code: 'key-conflict', message },
  ]);
}

function registeredOf(links: readonly Link[]): RegisteredRecord[] {
  const aliases = links[0]?.batch?.aliases ?? {};
  const aliasOf = new Map(Object.entries(aliases).map(([alias, id]) => [id, alias]));
  return links.map(({ id }) => {
    const alias = aliasOf.get(id);
    return alias === undefined ? { id } : { alias, id };
  });
}

/**
 * Atribui os ids e resolve `@alias` e `kind`; as checagens estáticas já garantiram que o alias
 * existe. `aliases` é o mapa apelido para id que `linkItems` grava no `batch` do primeiro elo.
 */
function draftItems({ process, items }: DecideCall, newUuid: () => string): Drafted {
  const ided = items.map((prepared) => ({ prepared, id: `${process}:${newUuid()}` }));
  const aliasIds = new Map(
    ided.flatMap(({ prepared, id }) =>
      prepared.item.alias === undefined ? [] : [[prepared.item.alias, id] as const],
    ),
  );
  const drafts = ided.map(({ prepared: { item, relations }, id }) => ({
    id,
    item,
    relations: relations.map(({ input, kind }) => {
      const to = isAliasRef(input.to) ? aliasIds.get(input.to.slice(1))! : input.to;
      return { input, stored: { kind, to, ...(input.as !== undefined && { as: input.as }) } };
    }),
  }));
  return { drafts, aliases: Object.fromEntries(aliasIds) };
}

function* sitesOf(drafts: readonly Draft[]): Generator<Site> {
  for (const [index, draft] of drafts.entries()) {
    for (const [at, relation] of draft.relations.entries()) yield { index, at, draft, relation };
  }
}

const pathOf = ({ index, at }: Site) => `/records/${index}/relations/${at}`;

/**
 * D-10: aplica as regras estruturais de uma relação. `supersedes`/`revokes` leem a vigência dos
 * itens anteriores do lote; `supports`, a do lote inteiro, que recusa os dois lotes
 * `[supersedes → E, supports → E]` e `[supports → E, supersedes → E]`.
 */
function createEnforcer(
  names: ReadonlyMap<Name, NamedRelation>,
  verified: VerifiedProcess,
  drafts: readonly Draft[],
) {
  const batchLinks: Linked[] = drafts.map(({ id, relations }) => ({
    id,
    relations: relations.map(({ stored }) => stored),
  }));
  const wholeBatch = once(() => buildVigency([...verified.records, ...batchLinks]));
  const before = memoize((index: number) =>
    buildVigency([...verified.records, ...batchLinks.slice(0, index)]),
  );

  const enforce = (site: Site, to: RelationEnd, vigencyFor: RuleContext['vigencyFor']) => {
    const { draft, relation, at } = site;
    const result = checkRelation(relation.input, {
      from: { id: draft.id, type: draft.item.type },
      to,
      siblings: draft.relations.filter((_, other) => other !== at).map(({ stored }) => stored),
      names,
      vigencyFor,
    });
    if ('violation' in result) throw ruleRefusal(pathOf(site), result.violation);
  };

  return {
    batchLinks,
    inDestination: (site: Site, to: RelationEnd, { vigency }: Destination) =>
      enforce(site, to, () => vigency),
    inOrigin: (site: Site, to: RelationEnd) =>
      enforce(site, to, (kind) =>
        kind === 'supersedes' || kind === 'revokes' ? before(site.index) : wholeBatch(),
      ),
  };
}

type Enforcer = ReturnType<typeof createEnforcer>;

/** Leitura verificada do processo-destino; ausente, ilegível ou com quebra é `RELATION_NOT_FOUND`. */
function loadDestination(
  store: Pick<ProcessStore, 'read'>,
  ref: ProcessRef,
  path: string,
): Destination {
  let verified: VerifiedProcess;
  try {
    verified = loadVerified(store, ref);
  } catch (error) {
    if (error instanceof HexlogError && error.code === 'PROCESS_NOT_FOUND') {
      throw relationNotFound(path, 'missing');
    }
    if (error instanceof HexlogError && error.code === 'PROCESS_CORRUPTED') {
      throw relationNotFound(path, 'destination-corrupted', ref.process);
    }
    // O nome veio do `to` da relação, não do campo `/process` que a porta presume, e o erro é da
    // leitura do destino, não da origem: `process` o nomeia.
    throw withPath(error, `${path}/to`, ref.process);
  }
  if (!verified.chain.ok) throw relationNotFound(path, 'destination-corrupted', ref.process);
  return {
    types: new Map(verified.records.map(({ id, type }) => [id, type])),
    vigency: buildVigency(verified.records),
  };
}

/** D-10: relações que cruzam para outro processo, cada destino lido uma vez, sem travá-lo. */
function checkOtherProcesses(
  deps: Pick<DecideDeps, 'store'>,
  { project, process }: DecideCall,
  enforcer: Enforcer,
  drafts: readonly Draft[],
): void {
  const destinations = new Map<Name, Destination>();
  for (const site of sitesOf(drafts)) {
    const { to } = site.relation.stored;
    const destinationProcess = processOf(to);
    if (destinationProcess === process) continue;
    const destination =
      destinations.get(destinationProcess) ??
      loadDestination(deps.store, { project, process: destinationProcess }, pathOf(site));
    destinations.set(destinationProcess, destination);
    const type = destination.types.get(to);
    if (type === undefined) throw relationNotFound(pathOf(site), 'missing');
    enforcer.inDestination(site, { id: to, type }, destination);
  }
}

/** D-10: relações para registro da própria origem ou de item do lote. */
function checkOwnProcess(
  { process }: DecideCall,
  enforcer: Enforcer,
  verified: VerifiedProcess,
  drafts: readonly Draft[],
): void {
  const types = new Map(
    [...verified.records, ...drafts.map(({ id, item }) => ({ id, type: item.type }))].map(
      ({ id, type }) => [id, type],
    ),
  );
  for (const site of sitesOf(drafts)) {
    const { to } = site.relation.stored;
    if (processOf(to) !== process) continue;
    const type = types.get(to);
    if (type === undefined) throw relationNotFound(pathOf(site), 'missing');
    enforcer.inOrigin(site, { id: to, type });
  }
}

function cycleRejected(): HexlogError {
  const message = 'batch would create a supersedes cycle';
  return new HexlogError('CYCLE_REJECTED', message, [{ path: '', code: 'cycle', message }]);
}

/** D-04: um elo por item, só o primeiro leva `batch`, o hash de cada um encadeia no seguinte. */
function linkItems(
  call: DecideCall,
  verified: VerifiedProcess,
  drafts: readonly Draft[],
  aliases: Drafted['aliases'],
  at: string,
): Link[] {
  const { author, key, fingerprint } = call;
  const batch: Batch = {
    fingerprint,
    ...(key !== undefined && { key }),
    ...(Object.keys(aliases).length > 0 && { aliases }),
  };
  const stored = {
    agent: author.agent,
    ...(author.model !== undefined && { model: author.model }),
    client: author.client,
  };
  let prevHash = verified.end.prevHash;
  return drafts.map(({ id, item, relations }, index) => {
    const link: Link = {
      seq: verified.end.seq + index,
      id,
      type: item.type,
      at,
      target: item.target,
      author: stored,
      data: item.data,
      relations: relations.map((relation) => relation.stored),
      prevHash,
      ...(index === 0 && { batch }),
    };
    prevHash = hashLink(link);
    return link;
  });
}

/**
 * D-06 níveis 4 a 6, sob o lock da origem (D-25: síncrona, devolve a linha única ou lança):
 * cadeia, busca da `key` (replay sem linha ou conflito), e só então as checagens que dependem de
 * estado (destinos de outro processo, anexos, D-10, ciclo). Nada é gravado se algo falha.
 */
export function createDecide(
  deps: DecideDeps,
  call: DecideCall,
): (raw: RawProcess) => Decision<RegisterResult> {
  return (raw) => {
    const { process, key, fingerprint, project, names, items } = call;
    const verified = verifyProcess(raw);
    if (!verified.chain.ok) throw brokenChain(process);

    const prior = key === undefined ? undefined : verified.batches.get(key);
    if (prior !== undefined) {
      assertSameBatch(prior, fingerprint);
      const head = verified.records.at(-1)?.id ?? null;
      return {
        result: { records: registeredOf(prior.links), replayed: true, marker: { [process]: head } },
      };
    }

    const { drafts, aliases } = draftItems(call, deps.newUuid);
    const enforcer = createEnforcer(names, verified, drafts);
    checkOtherProcesses(deps, call, enforcer, drafts);
    checkAttachments(project, items, deps.attachments);
    checkOwnProcess(call, enforcer, verified, drafts);
    if (hasCycle([...verified.records, ...enforcer.batchLinks])) throw cycleRejected();

    const links = linkItems(call, verified, drafts, aliases, deps.clock().toISOString());
    const line = formatLine(links);
    if (isValidLine(line, verified.end).status !== 'valid') {
      throw new HexlogError('INTERNAL', 'built an invalid batch line');
    }
    const last = links.at(-1)!;
    return {
      line,
      result: { records: registeredOf(links), replayed: false, marker: { [process]: last.id } },
    };
  };
}
