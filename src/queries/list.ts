import { isUndefined, mapValues } from 'es-toolkit';
import type { Name } from '../domain/ids.ts';
import type { Manifest } from '../domain/manifest.ts';
import { invalidInput } from '../errors.ts';
import type { DefinitionKind, DefinitionReader, ProcessReader } from '../ports.ts';
import { latestVersions } from '../shared/latest.ts';
import { projectNotFound } from './read.ts';

export type ListInput = { project?: Name; process?: Name };

/** Definição do projeto: `version` é a mais nova, `versions` todas em ordem crescente. */
type DefinitionSummary = { name: Name; version: string; versions: string[] };

export type ListResult = {
  /** Sem `project`: um item por projeto. */
  projects?: { name: Name; processes: number }[];
  /** Só `project`: os processos e as definições vigentes dele. */
  project?: {
    name: Name;
    processes: { name: Name; createdAt: string }[];
  } & Record<DefinitionKind, DefinitionSummary[]>;
  /** `project` e `process`: o que o manifesto do processo fixou. */
  process?: {
    name: Name;
    createdAt: string;
    pinned: Record<DefinitionKind, Name[]>;
    hashes: Manifest['hashes'];
  };
};

export function createList(deps: {
  store: ProcessReader;
  definitions: DefinitionReader;
}): (input: ListInput) => ListResult {
  const { store, definitions } = deps;

  return ({ project, process }) => {
    if (isUndefined(project)) {
      if (!isUndefined(process)) {
        throw invalidInput('/project', 'required', 'project is required with process');
      }
      return {
        projects: store
          .listProjects()
          .map((name) => ({ name, processes: store.list(name).length })),
      };
    }
    if (!store.listProjects().includes(project)) throw projectNotFound();
    if (!isUndefined(process)) {
      const { createdAt, fixed, hashes } = store.readManifest({ project, process });
      return {
        process: {
          name: process,
          createdAt,
          pinned: mapValues(fixed, (byName) => Object.keys(byName)),
          hashes,
        },
      };
    }
    return {
      project: {
        name: project,
        processes: store.list(project).map((name) => ({
          name,
          createdAt: store.readManifest({ project, process: name }).createdAt,
        })),
        types: latestVersions(definitions, project, 'types'),
        relations: latestVersions(definitions, project, 'relations'),
        gates: latestVersions(definitions, project, 'gates'),
      },
    };
  };
}
