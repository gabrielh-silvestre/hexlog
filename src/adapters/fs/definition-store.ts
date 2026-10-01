import fs from 'node:fs';
import * as path from 'node:path';
import type { ZodType } from 'zod';
import { Gate, RecordType, RelationName, compareVersions } from '../../domain/definitions.ts';
import type { Name } from '../../domain/ids.ts';
import { HexlogError, type ErrorCode } from '../../errors.ts';
import type { DefinitionKind, DefinitionOf, DefinitionStore } from '../../ports.ts';
import { errnoCode, writeFileAtomic } from './atomic.ts';
import { dataRoot } from './data-format.ts';
import { listDirectories, mapIo, readTextIfPresent, safeName } from './io.ts';

export type DefinitionStoreOptions = {
  /** `<D>`; o store grava só em `<D>/.v1/<projeto>/{types,relations,gates}/` (D-02). */
  dataDir: string;
};

const SCHEMAS: { [K in DefinitionKind]: ZodType<DefinitionOf[K]> } = {
  types: RecordType,
  relations: RelationName,
  gates: Gate,
};

const NOT_FOUND: Record<DefinitionKind, ErrorCode> = {
  types: 'TYPE_NOT_FOUND',
  relations: 'RELATION_NOT_FOUND',
  gates: 'GATE_NOT_FOUND',
};

// Forma canônica: sem zero à esquerda, senão `01.0` e `1.0` seriam dois arquivos da mesma versão.
const CANONICAL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_SUFFIX = '.json';

/** A versão vira nome de arquivo, então passa por aqui antes de qualquer I/O. */
function safeVersion(version: string): string {
  if (!CANONICAL_VERSION.test(version)) {
    const message = 'invalid version';
    throw new HexlogError('INVALID_INPUT', message, [
      { path: '/version', code: 'invalid-version', message },
    ]);
  }
  return version;
}

/**
 * Definição ausente: sem `existing` ou com a lista vazia, o nome não tem nenhuma versão (pasta
 * inexistente ou vazia: `unknown-name`); com versões, o nome existe e a pedida não
 * (`unknown-version`, listando as que existem, nunca vazia).
 */
function definitionNotFound(kind: DefinitionKind, existing: string[] | undefined): HexlogError {
  if (!existing?.length) {
    const message = 'definition name not found';
    return new HexlogError(NOT_FOUND[kind], message, [
      { path: '/name', code: 'unknown-name', message },
    ]);
  }
  const message = 'definition version not found';
  return new HexlogError(NOT_FOUND[kind], message, [
    { path: '/version', code: 'unknown-version', message, versions: existing },
  ]);
}

/** Versões canônicas em `dir`, da menor para a maior; `undefined` se a pasta não existe. */
function readVersions(dir: string): string[] | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(VERSION_SUFFIX))
    .map((entry) => entry.name.slice(0, -VERSION_SUFFIX.length))
    .filter((version) => CANONICAL_VERSION.test(version))
    .sort(compareVersions);
}

function unreadableDefinition(): HexlogError {
  const message = 'definition file is unreadable';
  return new HexlogError('INTERNAL', message, [
    { path: '/version', code: 'unreadable-definition', message },
  ]);
}

/**
 * `DefinitionStore` sobre `<D>/.v1/<projeto>/<tipo>/<nome>/<major>.<minor>.json` (D-02, D-25).
 * Versão gravada é imutável. O arquivo legado `<nome>.json` do 0.x nunca é lido, gravado nem
 * materializado: o store só enxerga o que mora em `.v1`.
 */
export function createDefinitionStore({ dataDir }: DefinitionStoreOptions): DefinitionStore {
  const root = dataRoot(dataDir);

  const kindDir = (project: Name, kind: DefinitionKind) =>
    path.join(root, safeName(project, '/project'), kind);
  const nameDir = (project: Name, kind: DefinitionKind, name: Name) =>
    path.join(kindDir(project, kind), safeName(name, '/name'));
  const versionFile = (project: Name, kind: DefinitionKind, name: Name, version: string) =>
    path.join(nameDir(project, kind, name), `${safeVersion(version)}${VERSION_SUFFIX}`);

  return {
    names: (project, kind) => mapIo(() => listDirectories(kindDir(project, kind))),

    versions: (project, kind, name) =>
      mapIo(() => readVersions(nameDir(project, kind, name)) ?? []),

    read: <K extends DefinitionKind>(project: Name, kind: K, name: Name, version: string) =>
      mapIo(() => {
        const text = readTextIfPresent(versionFile(project, kind, name, version));
        if (text === undefined) {
          throw definitionNotFound(kind, readVersions(nameDir(project, kind, name)));
        }
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw unreadableDefinition();
        }
        const parsed = SCHEMAS[kind].safeParse(value);
        if (!parsed.success) throw unreadableDefinition();
        return parsed.data;
      }),

    write: (project, kind, name, version, definition) =>
      mapIo(() => {
        try {
          writeFileAtomic(versionFile(project, kind, name, version), JSON.stringify(definition), {
            exclusive: true,
            fsyncDir: true,
          });
          return true;
        } catch (error) {
          if (errnoCode(error) === 'EEXIST') return false;
          throw error;
        }
      }),
  };
}
