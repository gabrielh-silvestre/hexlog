import type { Hash, Marker, Name, RecordId } from '../domain/ids.ts';
import { HexlogError } from '../errors.ts';
import type { ProcessReader, ProcessRef } from '../ports.ts';
import { loadVerified, type VerifiedProcess } from '../shared/loader.ts';

/** D-24: o que a leitura cobre; o alcance processo exige o nome do processo. */
export type ReadTarget =
  { project: Name; scope: 'process'; process: Name } | { project: Name; scope: 'project' };

/** Processo lido e verificado, cortado no marcador quando houve um. */
export type LoadedProcess = { name: Name; verified: VerifiedProcess };

export type Reading = {
  processes: LoadedProcess[];
  /** D-24: uma entrada por processo lido, `null` para processo vazio. */
  marker: Marker;
  /** Hash da cabeça lida de cada processo (`null` se vazio): prende o cursor ao conteúdo (D-20). */
  markerHashes: Record<Name, Hash | null>;
};

function brokenChain(process: Name): HexlogError {
  const message = 'process chain is broken';
  return new HexlogError('PROCESS_CORRUPTED', message, [
    { path: '/process', code: 'broken-chain', message, process },
  ]);
}

export function projectNotFound(): HexlogError {
  const message = 'project not found';
  return new HexlogError('PROJECT_NOT_FOUND', message, [
    { path: '/project', code: 'unknown-project', message },
  ]);
}

function markerProcessNotFound(process: Name): HexlogError {
  const message = 'marker names a process that does not exist';
  return new HexlogError('MARKER_NOT_FOUND', message, [
    { path: '/marker', code: 'process-not-found', message, process },
  ]);
}

/** D-24: ordem de nome por unidade de código, que é a do `sort` padrão. */
function namesOf(store: ProcessReader, target: ReadTarget, marker?: Marker): Name[] {
  if (target.scope === 'process') return [target.process];
  if (!store.listProjects().includes(target.project)) throw projectNotFound();
  const names = store.list(target.project).sort();
  const missing = Object.keys(marker ?? {}).find((name) => !names.includes(name));
  if (missing !== undefined) throw markerProcessNotFound(missing);
  return names;
}

/**
 * `loadVerified` cortado em `cutAt`. O elo marcado que a adulteração fez o carregador rejeitar não
 * está em nenhuma linha aceita e sairia como `MARKER_NOT_FOUND`: relê o processo inteiro (só neste
 * caminho de erro) e, se a cadeia dele não está íntegra, o erro certo é a quebra.
 */
function loadCut(
  store: ProcessReader,
  ref: ProcessRef,
  cutAt: RecordId | null | undefined,
): VerifiedProcess {
  try {
    return loadVerified(store, ref, cutAt);
  } catch (error) {
    const lostMarker = error instanceof HexlogError && error.code === 'MARKER_NOT_FOUND';
    if (lostMarker && cutAt != null && !loadVerified(store, ref).chain.ok) {
      throw brokenChain(ref.process);
    }
    throw error;
  }
}

/**
 * D-24: lê e verifica o alcance pedido, pelo carregador único. Com `marker`, cada processo é lido
 * até o id marcado e o ausente do marcador é lido como vazio (nasceu depois). Quebra de cadeia dá
 * `PROCESS_CORRUPTED` nomeando o processo, nos dois alcances: nada é avaliado sobre leitura parcial.
 */
export function readScope(store: ProcessReader, target: ReadTarget, marker?: Marker): Reading {
  const processes = namesOf(store, target, marker).map((name): LoadedProcess => {
    const cutAt = marker === undefined ? undefined : (marker[name] ?? null);
    const verified = loadCut(store, { project: target.project, process: name }, cutAt);
    if (!verified.chain.ok) throw brokenChain(name);
    return { name, verified };
  });
  const heads = processes.map(({ name, verified }) => {
    const empty = verified.records.length === 0;
    return {
      name,
      id: verified.records.at(-1)?.id ?? null,
      hash: empty ? null : verified.chain.head,
    };
  });
  return {
    processes,
    marker: Object.fromEntries(heads.map(({ name, id }) => [name, id])),
    markerHashes: Object.fromEntries(heads.map(({ name, hash }) => [name, hash])),
  };
}
