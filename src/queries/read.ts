import type { Hash, Marker, Name, RecordId } from '../domain/ids.ts';
import { brokenChain, HexlogError } from '../errors.ts';
import type { ProcessReader, ProcessRef } from '../ports.ts';
import { loadVerified, type VerifiedProcess } from '../shared/loader.ts';

/** D-24: o que a leitura cobre; o alcance processo exige o nome do processo. */
export type ReadTarget =
  { project: Name; scope: 'process'; process: Name } | { project: Name; scope: 'project' };

/** Processo lido e verificado, cortado no marcador quando houve um. */
type LoadedProcess = { name: Name; verified: VerifiedProcess };

export type Reading = {
  processes: LoadedProcess[];
  /** D-24: uma entrada por processo lido, `null` para processo vazio. */
  marker: Marker;
  /** Hash da cabeça lida de cada processo (`null` se vazio): prende o cursor ao conteúdo (D-20). */
  markerHashes: Record<Name, Hash | null>;
};

export function projectNotFound(): HexlogError {
  const message = 'project not found';
  return new HexlogError('PROJECT_NOT_FOUND', message, [
    { path: '/project', code: 'unknown-project', message },
  ]);
}

function markerProcessNotFound(
  process: Name,
  message = 'marker names a process that does not exist',
): HexlogError {
  return new HexlogError('MARKER_NOT_FOUND', message, [
    { path: '/marker', code: 'process-not-found', message, process },
  ]);
}

/**
 * D-24: alcance processo, o marcador tem exatamente uma entrada, a do processo lido; ausente ou
 * extra é entrada malformada (ler como vazio faria o gate passar por vacuidade). Alcance projeto,
 * ordem de nome por unidade de código, a mesma que `ProcessReader.list` devolve.
 */
function namesOf(store: ProcessReader, target: ReadTarget, marker?: Marker): Name[] {
  if (target.scope === 'process') {
    if (marker === undefined) return [target.process];
    if (!Object.hasOwn(marker, target.process)) {
      throw markerProcessNotFound(target.process, 'marker has no entry for the read process');
    }
    const extra = Object.keys(marker).find((name) => name !== target.process);
    if (extra !== undefined) {
      throw markerProcessNotFound(extra, 'marker names a process that was not read');
    }
    return [target.process];
  }
  if (!store.listProjects().includes(target.project)) throw projectNotFound();
  const names = store.list(target.project);
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
 * até o id marcado; só no alcance projeto o ausente do marcador é lido como vazio (nasceu depois),
 * no alcance processo a falta da entrada do processo lido é `MARKER_NOT_FOUND`. Quebra de cadeia
 * dá `PROCESS_CORRUPTED` nomeando o processo, nos dois alcances: nada é avaliado sobre leitura
 * parcial. `markerPath` é o campo da entrada que traz o marcador (D-26) e vai no `path` do
 * `MARKER_NOT_FOUND`: `/marker`, `/cursor` ou `/changesSince`.
 */
export function readScope(
  store: ProcessReader,
  target: ReadTarget,
  marker?: Marker,
  markerPath = '/marker',
): Reading {
  try {
    return readCut(store, target, marker);
  } catch (error) {
    if (!(error instanceof HexlogError) || error.code !== 'MARKER_NOT_FOUND') throw error;
    throw new HexlogError(
      error.code,
      error.message,
      error.details.map((detail) => ({ ...detail, path: markerPath })),
    );
  }
}

function readCut(store: ProcessReader, target: ReadTarget, marker?: Marker): Reading {
  const processes = namesOf(store, target, marker).map((name): LoadedProcess => {
    const cutAt =
      marker === undefined ? undefined : Object.hasOwn(marker, name) ? marker[name] : null;
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
