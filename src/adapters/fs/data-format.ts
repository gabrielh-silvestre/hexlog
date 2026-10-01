import * as fs from 'node:fs';
import * as path from 'node:path';
import { errnoCode } from './atomic.ts';

/**
 * Padrão de nome do 0.4.0 (`NAME_SRC`): o conjunto de nomes que o 0.x cria em `<D>`.
 * Não casa `.v1` nem entradas de ponto, que nenhum servidor 0.x consegue criar.
 */
export const LEGACY_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Pasta dos pacotes do arquivamento 0.x: casa `LEGACY_NAME`, mas não é dado 0.x. */
const ARCHIVE_DIR = 'archive';

/** Raiz do dado 1.0: `<dataDir>/.v1`. */
export function dataRoot(dataDir: string): string {
  return path.join(dataDir, '.v1');
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
