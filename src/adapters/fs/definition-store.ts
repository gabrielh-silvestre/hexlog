import fs from 'node:fs';
import { isUndefined } from 'es-toolkit';
import type { ZodType } from 'zod';
import {
  CANONICAL_VERSION,
  Gate,
  RecordType,
  RelationName,
  compareVersions,
} from '../../domain/definitions.ts';
import type { Name } from '../../domain/ids.ts';
import { HexlogError, invalidInput, type ErrorCode } from '../../errors.ts';
import type { DefinitionKind, DefinitionOf, DefinitionStore } from '../../ports.ts';
import { errnoCode, writeFileAtomic } from './atomic.ts';
import { definitionDir, definitionFile, VERSION_SUFFIX } from './data-format.ts';
import { listDirectories, mapIo, orIfMissing, readIfPresent, safeName } from './io.ts';

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

/** A versão vira nome de arquivo, então passa por aqui antes de qualquer I/O. */
function safeVersion(version: string): string {
  if (!CANONICAL_VERSION.test(version)) {
    throw invalidInput('/version', 'invalid-version', 'invalid version');
  }
  return version;
}

/**
 * Definição ausente: com a lista `existing` vazia, o nome não tem nenhuma versão (pasta inexistente
 * ou vazia: `unknown-name`); com versões, o nome existe e a pedida não (`unknown-version`,
 * listando as que existem, nunca vazia).
 */
function definitionNotFound(kind: DefinitionKind, existing: string[]): HexlogError {
  if (existing.length === 0) {
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

/** Versões canônicas em `dir`, da menor para a maior; pasta inexistente não tem nenhuma. */
function readVersions(dir: string): string[] {
  return orIfMissing(() => fs.readdirSync(dir, { withFileTypes: true }), [])
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

/** Definição que o próprio `read` recusaria: gravá-la envenenaria uma versão imutável. */
function invalidDefinition(): HexlogError {
  const message = 'definition does not match its schema';
  return new HexlogError('INTERNAL', message, [
    { path: '/definition', code: 'invalid-definition', message },
  ]);
}

/**
 * `DefinitionStore` sobre `<D>/.v1/<projeto>/<tipo>/<nome>/<major>.<minor>.json` (D-02, D-25).
 * Versão gravada é imutável. O arquivo legado `<nome>.json` do 0.x nunca é lido, gravado nem
 * materializado: o store só enxerga o que mora em `.v1`.
 */
export function createDefinitionStore({ dataDir }: DefinitionStoreOptions): DefinitionStore {
  const kindDir = (project: Name, kind: DefinitionKind) =>
    definitionDir(dataDir, safeName(project, '/project'), kind);
  const nameDir = (project: Name, kind: DefinitionKind, name: Name) =>
    definitionDir(dataDir, safeName(project, '/project'), kind, safeName(name, '/name'));
  const versionFile = (project: Name, kind: DefinitionKind, name: Name, version: string) =>
    definitionFile(
      dataDir,
      safeName(project, '/project'),
      kind,
      safeName(name, '/name'),
      safeVersion(version),
    );

  return {
    names: (project, kind) => mapIo(() => listDirectories(kindDir(project, kind))),

    versions: (project, kind, name) => mapIo(() => readVersions(nameDir(project, kind, name))),

    read: <K extends DefinitionKind>(project: Name, kind: K, name: Name, version: string) =>
      mapIo(() => {
        const text = readIfPresent(versionFile(project, kind, name, version));
        if (isUndefined(text)) {
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
        const parsed = SCHEMAS[kind].safeParse(definition);
        if (!parsed.success) throw invalidDefinition();
        try {
          writeFileAtomic(versionFile(project, kind, name, version), JSON.stringify(parsed.data), {
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
