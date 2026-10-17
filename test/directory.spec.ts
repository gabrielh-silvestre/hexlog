import { describe, it, expect } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import { dataDir } from '../src/directory.ts';

describe('dataDir', () => {
  it('should resolve to <XDG_DATA_HOME>/hexlog when XDG_DATA_HOME is absolute and non-empty', () => {
    expect(dataDir({ XDG_DATA_HOME: '/x' })).toBe('/x/hexlog');
  });

  it('should fall back to <home>/.local/share/hexlog when XDG_DATA_HOME is empty', () => {
    expect(dataDir({ XDG_DATA_HOME: '' })).toBe(
      path.join(os.homedir(), '.local', 'share', 'hexlog'),
    );
  });

  it('should fall back to <home>/.local/share/hexlog when XDG_DATA_HOME is relative', () => {
    expect(dataDir({ XDG_DATA_HOME: 'rel' })).toBe(
      path.join(os.homedir(), '.local', 'share', 'hexlog'),
    );
  });
});
