import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DefinitionKind, ProcessRef } from '../../ports.ts';
import { errnoCode } from './atomic.ts';

/**
 * Padrão de nome do 0.4.0 (`NAME_SRC`): o conjunto de nomes que o 0.x cria em `<D>`.
 * Não casa `.v1` nem entradas de ponto, que nenhum servidor 0.x consegue criar.
 */
export const LEGACY_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Pasta dos pacotes do arquivamento 0.x: casa `LEGACY_NAME`, mas não é dado 0.x. */
export const ARCHIVE_DIR = 'archive';

/** Pasta dos blobs de anexo de um projeto; nome reservado de processo (`RESERVED_PROCESS_NAMES`). */
export const ATTACHMENTS_DIR = 'attachments';

/** Sufixo do arquivo de uma versão de definição: `<major>.<minor>.json`. */
export const VERSION_SUFFIX = '.json';

/** Raiz do dado 1.0: `<dataDir>/.v1`. */
export function dataRoot(dataDir: string): string {
  return path.join(dataDir, '.v1');
}

export const MANIFEST_FILE = 'process.json';
export const LOG_FILE = 'records.jsonl';
export const LOCK_DIR = `${LOG_FILE}.lock`;

/** Caminhos de um processo em `<D>/.v1/<project>/<process>/`; `ref` já vem com nomes validados. */
export function processPaths(dataDir: string, ref: ProcessRef) {
  const dir = path.join(dataRoot(dataDir), ref.project, ref.process);
  return {
    dir,
    manifest: path.join(dir, MANIFEST_FILE),
    log: path.join(dir, LOG_FILE),
    lock: path.join(dir, LOCK_DIR),
  };
}

/**
 * Pasta de `kind` num projeto, ou a de um `name` dentro dela (as versões); `project` e `name` já
 * vêm validados.
 */
export function definitionDir(
  dataDir: string,
  project: string,
  kind: DefinitionKind,
  name?: string,
): string {
  const kindDir = path.join(dataRoot(dataDir), project, kind);
  return name === undefined ? kindDir : path.join(kindDir, name);
}

/** Arquivo de uma versão de definição; `project`, `name` e `version` já vêm validados. */
export function definitionFile(
  dataDir: string,
  project: string,
  kind: DefinitionKind,
  name: string,
  version: string,
): string {
  return path.join(definitionDir(dataDir, project, kind, name), `${version}${VERSION_SUFFIX}`);
}

/** Pasta dos blobs de anexo de um projeto; `project` já vem validado. */
export function attachmentsDir(dataDir: string, project: string): string {
  return path.join(dataRoot(dataDir), project, ATTACHMENTS_DIR);
}

/** Blob de anexo, nomeado pelo sha256 dos bytes; `project` e `hash` já vêm validados. */
export function blobFile(dataDir: string, project: string, hash: string): string {
  return path.join(attachmentsDir(dataDir, project), hash);
}

/**
 * Entradas de `dataDir` que são dado 0.x (detecção positiva, D-13), em ordem alfabética:
 * qualquer nome que casa `LEGACY_NAME`, exceto `archive`. `dataDir` inexistente não tem dado 0.x.
 * Teto aceito: um projeto 0.x chamado `archive` não é detectado.
 */
export function detectLegacy(dataDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dataDir);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((name) => name !== ARCHIVE_DIR && LEGACY_NAME.test(name)).sort();
}
