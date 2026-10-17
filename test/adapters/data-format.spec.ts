import { describe, expect, it } from '@jest/globals';
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

describe('LEGACY_NAME', () => {
  it.each(['a', '0a', 'rdsc', 'meu-projeto', 'archive', 'x'.repeat(63)])(
    'should match %s (D-13)',
    (name) => {
      expect(LEGACY_NAME.test(name)).toBe(true);
    },
  );

  it.each(['', '.v1', '.omc', '-a', 'A', 'a_b', 'a.b', 'x'.repeat(64)])(
    'should not match %s (D-13)',
    (name) => {
      expect(LEGACY_NAME.test(name)).toBe(false);
    },
  );
});

describe('dataRoot', () => {
  it('should return <D>/.v1 as the root of the 1.0 data', () => {
    expect(dataRoot('/dados/hexlog')).toBe(path.join('/dados/hexlog', '.v1'));
  });
});

// Um `DefinitionKind` novo quebra o typecheck aqui, e o teste abaixo cobra a lista de reservados.
const KINDS = { types: 0, relations: 0, gates: 0 } satisfies Record<DefinitionKind, 0>;

describe('RESERVED_PROCESS_NAMES', () => {
  it('should be exactly the sibling folders of a process: one per definition kind, attachments and archive', () => {
    expect([...RESERVED_PROCESS_NAMES].sort()).toEqual(
      [...Object.keys(KINDS), ATTACHMENTS_DIR, ARCHIVE_DIR].sort(),
    );
  });
});

describe('detectLegacy', () => {
  it('should return every lowercase-named entry in alphabetical order (TI5)', () => {
    const dir = dataDirWith(['zeta/', 'alfa/', 'notas']);

    expect(detectLegacy(dir)).toEqual(['alfa', 'notas', 'zeta']);
  });

  it('should not count the archive folder of the packages as 0.x, since archive is a reserved name (TI5)', () => {
    const dir = dataDirWith(['archive/', 'projeto/']);

    expect(detectLegacy(dir)).toEqual(['projeto']);
  });

  it('should never match .v1, .omc or any dot entry (TI5)', () => {
    const dir = dataDirWith(['.v1/', '.omc/', '.oculto']);

    expect(detectLegacy(dir)).toEqual([]);
  });

  it('should not treat the 1.0 data alone as 0.x (TI5)', () => {
    const dir = dataDirWith(['.v1/', 'archive/']);

    expect(detectLegacy(dir)).toEqual([]);
  });

  it('should not let the 1.0 data hide the 0.x when they are mixed (TI5)', () => {
    const dir = dataDirWith(['.v1/', 'archive/']);
    fs.mkdirSync(path.join(dir, 'projeto'));

    expect(detectLegacy(dir)).toEqual(['projeto']);
  });

  it('should ignore a name outside the 0.x pattern (uppercase, underscore, 64 characters) (TI5)', () => {
    const dir = dataDirWith(['Projeto/', 'a_b/', `${'x'.repeat(64)}/`, `${'y'.repeat(63)}/`]);

    expect(detectLegacy(dir)).toEqual(['y'.repeat(63)]);
  });

  it('should find no 0.x data in an empty <D> (TI5)', () => {
    const dir = dataDirWith([]);

    expect(detectLegacy(dir)).toEqual([]);
  });

  it('should find no 0.x data in a missing <D> (TI5)', () => {
    const dir = dataDirWith([]);

    expect(detectLegacy(path.join(dir, 'ausente'))).toEqual([]);
  });

  it('should throw a read error other than ENOENT raw (TI5)', () => {
    const dir = dataDirWith(['arquivo']);

    expect(() => detectLegacy(path.join(dir, 'arquivo'))).toThrow(
      expect.objectContaining({ code: 'ENOTDIR' }),
    );
  });
});
