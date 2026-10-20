import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { releaseNotes } from '../scripts/release-notes.ts';
import { VERSION } from '../src/version.ts';
import { createTempDir } from './helpers.ts';

const PR = { number: 7, url: 'https://github.com/o/r/pull/7' };

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Não lançado]',
  '',
  '## [2.0.0] - 2026-11-01',
  '',
  'Resumo da 2.0.0.',
  '',
  '### Adicionado',
  '',
  '- Coisa nova (#1).',
  '',
  '### Migração',
  '',
  '```sh',
  '### não é título',
  '```',
  '',
  '## [1.0.0] - 2026-10-01',
  '',
  '### Adicionado',
  '',
  '- Coisa velha (#0).',
  '',
].join('\n');

describe('releaseNotes', () => {
  test('puts the opening paragraph, the PR line, the demoted subsections and the install block in order', () => {
    const body = releaseNotes(CHANGELOG, '2.0.0', PR);
    expect(body.indexOf('Resumo da 2.0.0.')).toBeLessThan(
      body.indexOf('PR da release: [#7](https://github.com/o/r/pull/7)'),
    );
    expect(body.indexOf('PR da release')).toBeLessThan(body.indexOf('## Adicionado'));
    expect(body.indexOf('## Migração')).toBeLessThan(body.indexOf('## Instalação'));
    expect(body).toContain('node scripts/install.ts --check');
    expect(body.endsWith('e `docs/`.\n')).toBe(true);
  });

  test('demotes ### to ## outside code fences only', () => {
    const body = releaseNotes(CHANGELOG, '2.0.0', PR);
    expect(body).not.toMatch(/^### (Adicionado|Migração)/m);
    expect(body).toContain('\n### não é título\n');
  });

  test('stops at the next version section', () => {
    const body = releaseNotes(CHANGELOG, '2.0.0', PR);
    expect(body).not.toContain('Coisa velha');
    expect(body).not.toContain('Não lançado');
  });

  test('without an opening paragraph, only the PR line precedes the subsections', () => {
    const body = releaseNotes(CHANGELOG, '1.0.0', PR);
    expect(
      body.startsWith('PR da release: [#7](https://github.com/o/r/pull/7)\n\n## Adicionado'),
    ).toBe(true);
  });

  test('without a PR, the line is omitted', () => {
    const body = releaseNotes(CHANGELOG, '2.0.0');
    expect(body).not.toContain('PR da release');
    expect(body.startsWith('Resumo da 2.0.0.\n\n## Adicionado')).toBe(true);
  });

  test('a section with an opening paragraph and no subsection keeps the paragraph', () => {
    const body = releaseNotes('## [3.0.0] - 2026-12-01\n\nSó resumo.\n', '3.0.0');
    expect(body.startsWith('Só resumo.\n\n## Instalação')).toBe(true);
  });

  test('a missing or empty section throws', () => {
    expect(() => releaseNotes(CHANGELOG, '9.9.9')).toThrow('no section for 9.9.9');
    expect(() => releaseNotes(CHANGELOG, '2.0')).toThrow('no section for 2.0');
    expect(() => releaseNotes('## [4.0.0] - 2027-01-01\n\n## [3.0.0]\n- x\n', '4.0.0')).toThrow(
      'is empty',
    );
  });
});

describe('release-notes-cli', () => {
  const CLI_TIMEOUT = 15_000;
  const cli = path.resolve(__dirname, '..', 'scripts', 'release-notes-cli.ts');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: CLI_TIMEOUT });

  test(
    'prints the body of the package.json version from the real CHANGELOG.md',
    () => {
      const result = run(VERSION, '--pr', '12', '--repo', 'o/r');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('PR da release: [#12](https://github.com/o/r/pull/12)');
      expect(result.stdout).toContain('## Instalação');
    },
    CLI_TIMEOUT,
  );

  // Sem `node_modules`: o `release.yml` roda a CLI sem `npm ci`, então um import de pacote quebra a release
  test(
    'runs without node_modules, as the release workflow does',
    () => {
      const root = createTempDir('release-notes-bare');
      fs.mkdirSync(path.join(root, 'scripts'));
      for (const file of ['release-notes.ts', 'release-notes-cli.ts']) {
        fs.copyFileSync(
          path.resolve(__dirname, '..', 'scripts', file),
          path.join(root, 'scripts', file),
        );
      }
      fs.copyFileSync(
        path.resolve(__dirname, '..', 'CHANGELOG.md'),
        path.join(root, 'CHANGELOG.md'),
      );

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts', 'release-notes-cli.ts'), VERSION],
        { encoding: 'utf8', timeout: CLI_TIMEOUT },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('## Instalação');
    },
    CLI_TIMEOUT,
  );

  test(
    'an empty --pr means no PR line',
    () => {
      const result = run(VERSION, '--pr', '');
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('PR da release');
    },
    CLI_TIMEOUT,
  );

  test.each([
    ['no version', []],
    ['an extra argument', [VERSION, 'x']],
    ['a non-numeric --pr', [VERSION, '--pr', 'x', '--repo', 'o/r']],
    ['--pr without --repo', [VERSION, '--pr', '1']],
    ['an unknown option', [VERSION, '--nope']],
  ])(
    'rejects %s with exit 1',
    (_name, args) => {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('release-notes failed');
    },
    CLI_TIMEOUT,
  );

  test(
    'an unknown version exits 1',
    () => {
      const result = run('0.0.0');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no section for 0.0.0');
    },
    CLI_TIMEOUT,
  );
});
