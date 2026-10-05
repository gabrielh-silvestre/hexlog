import { isEqual, isUndefined, mapValues, omitBy, union } from 'es-toolkit';
import { fingerprint, hashOfJcs } from '../domain/chain.ts';
import { isReservedProcessName, type Name } from '../domain/ids.ts';
import type { Manifest } from '../domain/manifest.ts';
import { HexlogError, reservedName } from '../errors.ts';
import type {
  AttachmentStore,
  DefinitionKind,
  DefinitionOf,
  DefinitionStore,
  ProcessStore,
  Validator,
} from '../ports.ts';
import { latestVersions } from '../shared/latest.ts';
import type { Logger } from '../shared/logger.ts';
import { createDecide, type RegisterInput, type RegisterResult } from './register/state.ts';
import { checkBatchShape, prepareBatch, relationNames } from './register/static.ts';

export type { RegisterInput, RegisterResult } from './register/state.ts';

export type CreateProcessInput = { project: Name; process: Name };

/**
 * Definição fixada no processo que difere da vigente agora: `current` é a versão vigente, ou `null`
 * quando o nome não tem mais versão no projeto. O manifesto guarda o conteúdo fixado, não a versão
 * (D-03), então a versão fixada não é reportada.
 */
export type StaleDefinition = { kind: DefinitionKind; name: Name; current: string | null };

export type CreateProcessResult = {
  project: Name;
  process: Name;
  created: boolean;
  /** Nomes fixados no manifesto do processo (o recém-criado ou o que já existia). */
  pinned: Record<DefinitionKind, Name[]>;
  /** Só quando o processo já existia e alguma definição vigente diverge da fixada. */
  stale?: StaleDefinition[];
};

export type ProcessService = {
  /**
   * D-18: idempotente por nome. Fixa a versão vigente de cada tipo, nome de relação e gate do projeto
   * num manifesto novo (`created: true`); se o processo já existe, devolve o manifesto existente
   * intacto (`created: false`), com `stale` nas definições que mudaram desde a fixação. Projeto sem
   * nenhum tipo, relação ou gate recusa com `TYPE_NOT_FOUND` `unknown-name` em `/project`, sem criar
   * nada. Erro das portas (`TYPE_NOT_FOUND` etc., D-26) sai intacto, sem criar nada.
   *
   * Precedência: `RESERVED_NAME`, depois `TYPE_NOT_FOUND` do projeto vazio e só então a criação ou o
   * `created: false`. A checagem do projeto vazio roda antes de `store.create`, então um processo que
   * já existe num projeto que ficou sem definição também recusa com `TYPE_NOT_FOUND`.
   */
  createProcess(input: CreateProcessInput): CreateProcessResult;
  /**
   * D-06: grava o lote numa única linha do log de `process`, sob o lock só da origem. Ordem de
   * recusa, a primeira que falha responde: (1) forma do lote, (2) `PROCESS_NOT_FOUND` e
   * `unreadable-manifest`, (3) recusas estáticas (tipo fixado e schema, `as`→`kind`,
   * `cross-process-currency`), (4) `broken-chain`, (5) `key`: `replayed` ou `IDEMPOTENCY_CONFLICT`,
   * (6) destinos, anexos e regras de D-10. `PROCESS_TOO_LARGE` sai do adaptador ao ler o log sob o
   * lock (o nível 2 lê só o manifesto, então as recusas estáticas vencem) e ao gravar uma linha que
   * passaria do teto (depois do nível 6). Qualquer recusa sai antes de gravar.
   *
   * A entrada chega validada (ver `RegisterInput`). Um replay (`replayed: true`) emite
   * `batch-replayed` no logger (D-22), sem o conteúdo dos registros.
   *
   * O lock é solto depois do `fsync`: se `release` falha, o lote já está gravado e `register` lança
   * `IO_ERROR` mesmo assim. Reenviar com a mesma `key` devolve `replayed`; reenviar sem `key` duplica
   * o lote.
   */
  register(input: RegisterInput): Promise<RegisterResult>;
};

const KINDS = ['types', 'relations', 'gates'] as const satisfies readonly DefinitionKind[];

type Snapshot = {
  fixed: Manifest['fixed'];
  /** Versão vigente de cada nome fixado, por tipo de definição. */
  versions: Record<DefinitionKind, Map<Name, string>>;
};

function latestOf<K extends DefinitionKind>(
  definitions: DefinitionStore,
  project: Name,
  kind: K,
): { byName: Record<Name, DefinitionOf[K]>; versions: Map<Name, string> } {
  const latest = latestVersions(definitions, project, kind);
  return {
    byName: Object.fromEntries(
      latest.map(({ name, version }) => [name, definitions.read(project, kind, name, version)]),
    ),
    versions: new Map(latest.map(({ name, version }) => [name, version])),
  };
}

function takeSnapshot(definitions: DefinitionStore, project: Name): Snapshot {
  const types = latestOf(definitions, project, 'types');
  const relations = latestOf(definitions, project, 'relations');
  const gates = latestOf(definitions, project, 'gates');
  return {
    fixed: { types: types.byName, relations: relations.byName, gates: gates.byName },
    versions: { types: types.versions, relations: relations.versions, gates: gates.versions },
  };
}

const hashesOf = (fixed: Manifest['fixed']): Manifest['hashes'] =>
  mapValues(fixed, (byName) => hashOfJcs(byName));

const namesOf = (fixed: Manifest['fixed']): Record<DefinitionKind, Name[]> =>
  mapValues(fixed, (byName) => Object.keys(byName));

/** Nome presente só de um lado, ou com conteúdo diferente, conta como mudado. */
function staleOf(pinned: Manifest['fixed'], snapshot: Snapshot): StaleDefinition[] {
  return KINDS.flatMap((kind) => {
    // Map, não objeto: um nome como `constructor` leria o protótipo.
    const before = new Map(Object.entries(pinned[kind]));
    const now = new Map(Object.entries(snapshot.fixed[kind]));
    return union([...before.keys()], [...now.keys()])
      .filter((name) => !isEqual(before.get(name), now.get(name)))
      .map((name) => ({ kind, name, current: snapshot.versions[kind].get(name) ?? null }));
  });
}

function assertNotReserved(processName: Name): void {
  if (isReservedProcessName(processName)) throw reservedName();
}

/** Manifesto vazio é imutável e todo `register` daria `TYPE_NOT_PINNED`: melhor recusar a criar o processo. */
function assertSomethingRegistered(project: Name, fixed: Manifest['fixed']): void {
  if (KINDS.some((kind) => Object.keys(fixed[kind]).length > 0)) return;
  const message = `project '${project}' has no definitions; call define_type first`;
  throw new HexlogError('TYPE_NOT_FOUND', message, [
    { path: '/project', code: 'unknown-name', message },
  ]);
}

export function createProcessService(deps: {
  store: ProcessStore;
  definitions: DefinitionStore;
  attachments: AttachmentStore;
  validator: Validator;
  clock: () => Date;
  /** Uuid v7 do id do registro (D-01): opaco, nenhuma regra lê o tempo dele. */
  newUuid: () => string;
  logger: Logger;
}): ProcessService {
  const { store, definitions, attachments, validator, clock, newUuid, logger } = deps;

  return {
    createProcess({ project, process }) {
      assertNotReserved(process);
      const snapshot = takeSnapshot(definitions, project);
      assertSomethingRegistered(project, snapshot.fixed);
      const manifest: Manifest = {
        project,
        process,
        createdAt: clock().toISOString(),
        fixed: snapshot.fixed,
        hashes: hashesOf(snapshot.fixed),
      };
      const ref = { project, process };

      if (store.create(ref, manifest)) {
        return { project, process, created: true, pinned: namesOf(manifest.fixed) };
      }
      const existing = store.readManifest(ref);
      const result = { project, process, created: false, pinned: namesOf(existing.fixed) };
      const stale = staleOf(existing.fixed, snapshot);
      return stale.length === 0 ? result : { ...result, stale };
    },

    // ponytail: o lock da origem fica preso durante a leitura de cada processo-destino distinto. O
    // custo é por bytes: ~150 ms por destino de 5.000 registros (~100 destinos até os 15 s de
    // `LOCK_BUDGET_MS`) e ~2,2 a 2,5 s por destino no teto de 64 MiB (~6 a 7 destinos, extrapolado).
    // Acima disso quem espera recebe `LOCK_TIMEOUT` `lock-busy` e o servidor fica ocupado no `decide`
    // síncrono. O replay por `key` também paga o lock e o `verifyProcess` completo do log da origem,
    // e `prepareBatch` compila o schema de cada tipo distinto do lote, tudo antes de devolver
    // `replayed`. Melhoria: ler os destinos, que são append-only, antes do lock e, sob o lock,
    // verificar só os bytes novos a partir do marcador lido; ou um orçamento em bytes lidos (um
    // teto por contagem de destinos não protege onde importa). Reabrir no primeiro `lock-timeout`
    // real em `register` com relação cruzada, ou com processo real acima de ~10 MiB.
    async register({ project, process, author, key, records }) {
      checkBatchShape(records);
      const origin = { project, process };
      const manifest = store.readManifest(origin);
      const names = relationNames(manifest);
      const items = prepareBatch(manifest, names, records, validator);
      const decide = createDecide(
        { store, attachments, clock, newUuid },
        {
          project,
          process,
          author,
          key,
          fingerprint: fingerprint(records),
          items,
          names,
        },
      );
      const result = await store.write(origin, decide);
      // Só depois do `write`: o evento sai com o fsync feito e o lock solto, sem "replayed" falso após `IO_ERROR`.
      if (result.replayed) {
        logger({
          level: 'info',
          event: 'batch-replayed',
          project,
          process,
          ...omitBy({ key }, isUndefined),
        });
      }
      return result;
    },
  };
}
