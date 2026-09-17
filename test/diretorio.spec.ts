import { describe, test, expect } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import { dirDados } from '../src/diretorio.ts';

describe('dirDados (I1)', () => {
  test('XDG_DATA_HOME absoluto e não vazio → <XDG_DATA_HOME>/hexlog', () => {
    expect(dirDados({ XDG_DATA_HOME: '/x' })).toBe('/x/hexlog');
  });

  test('XDG_DATA_HOME vazio → <home>/.local/share/hexlog', () => {
    expect(dirDados({ XDG_DATA_HOME: '' })).toBe(path.join(os.homedir(), '.local', 'share', 'hexlog'));
  });

  test('XDG_DATA_HOME relativo → <home>/.local/share/hexlog', () => {
    expect(dirDados({ XDG_DATA_HOME: 'rel' })).toBe(path.join(os.homedir(), '.local', 'share', 'hexlog'));
  });
});
