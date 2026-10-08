import { describe, test, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VERSION } from '../src/version.ts';

const changelog = fs.readFileSync(path.resolve(__dirname, '..', 'CHANGELOG.md'), 'utf8');

/** Corpo de cada seção `## [título]`, até a próxima `## ` ou o fim do arquivo. */
function sections(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const block of text.split(/^## /m).slice(1)) {
    const title = /^\[([^\]]+)\]/.exec(block)?.[1];
    if (title !== undefined) found.set(title, block.slice(block.indexOf('\n') + 1));
  }
  return found;
}

describe('CHANGELOG.md', () => {
  const bySection = sections(changelog);

  test('tem a seção [Não lançado] para as mudanças ainda sem versão', () => {
    expect(bySection.has('Não lançado')).toBe(true);
  });

  // A seção da versão nasce no mesmo commit do bump de package.json#version.
  test('a versão do package.json tem seção datada com ao menos uma entrada', () => {
    expect(changelog).toMatch(
      new RegExp(`^## \\[${VERSION.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
    );
    expect(bySection.get(VERSION)).toMatch(/^- \S/m);
  });
});
