import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import * as path from 'node:path';
import {
  ARCHIVE_DIR,
  ATTACHMENTS_DIR,
  LEGACY_NAME,
  dataRoot,
  detectLegacy,
} from '../../src/adapters/fs/data-format.ts';
import { RESERVED_PROCESS_NAMES } from '../../src/domain/ids.ts';
import type { DefinitionKind } from '../../src/ports.ts';
import { createTempDir } from '../helpers.ts';

/** Cria `<D>` temporário com as entradas dadas: nome terminado em `/` vira diretório, o resto, arquivo. */
function dataDirWith(entries: string[]): string {
  const dir = createTempDir('data-format');
  for (const entry of entries) {
    const target = path.join(dir, entry);
    if (entry.endsWith('/')) fs.mkdirSync(target);
    else fs.writeFileSync(target, '');
  }
  return dir;
}

describe('LEGACY_NAME (D-13)', () => {
  test.each(['a', '0a', 'rdsc', 'meu-projeto', 'archive', 'x'.repeat(63)])('%s casa', (name) => {
    expect(LEGACY_NAME.test(name)).toBe(true);
  });

  test.each(['', '.v1', '.omc', '-a', 'A', 'a_b', 'a.b', 'x'.repeat(64)])('%s não casa', (name) => {
    expect(LEGACY_NAME.test(name)).toBe(false);
  });
});

describe('dataRoot', () => {
  test('a raiz do dado 1.0 é <D>/.v1', () => {
    expect(dataRoot('/dados/hexlog')).toBe(path.join('/dados/hexlog', '.v1'));
  });
});

// Um `DefinitionKind` novo quebra o typecheck aqui, e o teste abaixo cobra a lista de reservados.
const KINDS = { types: 0, relations: 0, gates: 0 } satisfies Record<DefinitionKind, 0>;

describe('RESERVED_PROCESS_NAMES', () => {
  test('são exatamente as pastas irmãs de um processo: uma por tipo de definição, anexos e arquivo', () => {
    expect([...RESERVED_PROCESS_NAMES].sort()).toEqual(
      [...Object.keys(KINDS), ATTACHMENTS_DIR, ARCHIVE_DIR].sort(),
    );
  });
});

describe('detectLegacy (TI5, detector)', () => {
  test('devolve, em ordem alfabética, toda entrada de nome minúsculo', () => {
    const dir = dataDirWith(['zeta/', 'alfa/', 'notas']);

    expect(detectLegacy(dir)).toEqual(['alfa', 'notas', 'zeta']);
  });

  test('archive é nome reservado: a pasta dos pacotes não conta como 0.x', () => {
    const dir = dataDirWith(['archive/', 'projeto/']);

    expect(detectLegacy(dir)).toEqual(['projeto']);
  });

  test('.v1, .omc e qualquer entrada de ponto nunca casam', () => {
    const dir = dataDirWith(['.v1/', '.omc/', '.oculto']);

    expect(detectLegacy(dir)).toEqual([]);
  });

  test('o dado 1.0 sozinho não é 0.x, e misturado não esconde o 0.x', () => {
    const dir = dataDirWith(['.v1/', 'archive/']);
    expect(detectLegacy(dir)).toEqual([]);

    fs.mkdirSync(path.join(dir, 'projeto'));
    expect(detectLegacy(dir)).toEqual(['projeto']);
  });

  test('nome fora do padrão do 0.x (maiúscula, sublinhado, 64 caracteres) é ignorado', () => {
    const dir = dataDirWith(['Projeto/', 'a_b/', `${'x'.repeat(64)}/`, `${'y'.repeat(63)}/`]);

    expect(detectLegacy(dir)).toEqual(['y'.repeat(63)]);
  });

  test('<D> vazio ou inexistente não tem dado 0.x', () => {
    const dir = dataDirWith([]);

    expect(detectLegacy(dir)).toEqual([]);
    expect(detectLegacy(path.join(dir, 'ausente'))).toEqual([]);
  });

  test('erro de leitura que não é ENOENT sai cru', () => {
    const dir = dataDirWith(['arquivo']);

    expect(() => detectLegacy(path.join(dir, 'arquivo'))).toThrow(
      expect.objectContaining({ code: 'ENOTDIR' }),
    );
  });
});
