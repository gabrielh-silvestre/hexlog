import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { releaseNotes } from '../scripts/release-notes.ts';
import { VERSION } from '../src/version.ts';
import { createTempDir } from './helpers.ts';

const PR = { number: 7, url: 'https://github.com/o/r/pull/7' };
const PR_LINE = 'PR da release: [#7](https://github.com/o/r/pull/7)';

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [2.0.0] - 2026-11-01',
  '',
  'Summary of 2.0.0.',
  '',
  '### Added',
  '',
  '- New thing (#1).',
  '',
  '### Migration',
  '',
  '```sh',
  '### not a heading',
  '```',
  '',
  '## [1.0.0] - 2026-10-01',
  '',
  '### Added',
  '',
  '- Old thing (#0).',
  '',
].join('\n');

/** Seção 5.0.0 com `## ` e `### ` dentro de uma cerca, seguida de uma subseção real e da seção 4.0.0. */
const sectionWithFence = (open: string, close: string) =>
  [
    '## [5.0.0] - 2027-02-01',
    '',
    'Summary of 5.0.0.',
    '',
    open,
    '## inside the fence',
    '### also inside the fence',
    close,
    '',
    '### Added',
    '',
    '- Real thing.',
    '',
    '## [4.0.0] - 2027-01-01',
    '',
    '- Older thing.',
    '',
  ].join('\n');

describe('releaseNotes', () => {
  const body = releaseNotes(CHANGELOG, '2.0.0', PR);

  test('puts the opening paragraph before the PR line', () => {
    expect(body.indexOf('Summary of 2.0.0.')).toBeLessThan(body.indexOf(PR_LINE));
  });

  test('puts the PR line before the subsections', () => {
    expect(body.indexOf(PR_LINE)).toBeLessThan(body.indexOf('## Added'));
  });

  test('puts the subsections before the install block', () => {
    expect(body.indexOf('## Migration')).toBeLessThan(body.indexOf('## Instalação'));
  });

  test('ends with the install block', () => {
    expect(body).toContain('node scripts/install.ts --check');
    expect(body.endsWith('e `docs/`.\n')).toBe(true);
  });

  test('demotes ### to ## outside code fences only', () => {
    expect(body).not.toMatch(/^### (Added|Migration)/m);
    expect(body).toContain('\n### not a heading\n');
  });

  test('stops at the next version section', () => {
    expect(body).not.toContain('Old thing');
    expect(body).not.toContain('Unreleased');
  });

  test('without an opening paragraph, only the PR line precedes the subsections', () => {
    expect(releaseNotes(CHANGELOG, '1.0.0', PR).startsWith(`${PR_LINE}\n\n## Added`)).toBe(true);
  });

  test('without a PR, the line is omitted', () => {
    const withoutPr = releaseNotes(CHANGELOG, '2.0.0');
    expect(withoutPr).not.toContain('PR da release');
    expect(withoutPr.startsWith('Summary of 2.0.0.\n\n## Added')).toBe(true);
  });

  test('a section with an opening paragraph and no subsection keeps the paragraph', () => {
    const only = releaseNotes('## [3.0.0] - 2026-12-01\n\nOnly a summary.\n', '3.0.0');
    expect(only.startsWith('Only a summary.\n\n## Instalação')).toBe(true);
  });

  test('a missing version throws', () => {
    expect(() => releaseNotes(CHANGELOG, '9.9.9')).toThrow('no section for 9.9.9');
  });

  test('a version prefix does not match another section', () => {
    expect(() => releaseNotes(CHANGELOG, '2.0')).toThrow('no section for 2.0');
  });

  test('an empty section throws', () => {
    expect(() => releaseNotes('## [4.0.0] - 2027-01-01\n\n## [3.0.0]\n- x\n', '4.0.0')).toThrow(
      'is empty',
    );
  });

  describe('code fences (CommonMark)', () => {
    test.each([
      ['a backtick fence', '```sh', '```'],
      ['a tilde fence', '~~~', '~~~'],
      ['a fence indented by three spaces', '   ```', '   ```'],
      ['a closing fence longer than the opening one', '```', '`````'],
    ])('keeps a section heading inside %s in the section', (_name, open, close) => {
      const notes = releaseNotes(sectionWithFence(open, close), '5.0.0');
      expect(notes).toContain('## inside the fence');
      expect(notes).toContain('- Real thing.');
      expect(notes).not.toContain('Older thing');
    });

    test('does not demote or take as the first subsection a ### inside a fence', () => {
      const notes = releaseNotes(sectionWithFence('~~~', '~~~'), '5.0.0');
      expect(notes).toContain('\n### also inside the fence\n');
      expect(notes.startsWith('Summary of 5.0.0.\n\n~~~\n## inside the fence')).toBe(true);
      expect(notes).toContain('\n\n## Added\n');
    });

    test('a shorter fence line does not close a longer fence', () => {
      const notes = releaseNotes(sectionWithFence('````', '```\n````'), '5.0.0');
      expect(notes).toContain('\n### also inside the fence\n');
      expect(notes).not.toContain('Older thing');
    });

    test('a closing line with text after it does not close the fence', () => {
      const notes = releaseNotes(sectionWithFence('```', '``` text\n```'), '5.0.0');
      expect(notes).toContain('\n### also inside the fence\n');
      expect(notes).toContain('- Real thing.');
    });

    test('a backtick line whose info string has a backtick is not a fence', () => {
      const changelog = ['## [6.0.0] - 2027-03-01', '', '```a`b', '### Added', '- x'].join('\n');
      expect(releaseNotes(changelog, '6.0.0')).toContain('\n## Added\n');
    });

    test('a fence indented by four spaces is indented code, not a fence', () => {
      const changelog = [
        '## [6.0.0] - 2027-03-01',
        '',
        'Summary.',
        '',
        '    ```',
        '### Added',
        '- x',
      ].join('\n');
      expect(releaseNotes(changelog, '6.0.0')).toContain('\n## Added\n');
    });
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
    'an empty --pr with a valid --repo means no PR line, as the release workflow passes them',
    () => {
      const result = run(VERSION, '--pr', '', '--repo', 'o/r');
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
    ['--repo without --pr', [VERSION, '--repo', 'o/r']],
    ['an empty --repo', [VERSION, '--pr', '1', '--repo', '']],
    ['a --repo without an owner', [VERSION, '--pr', '1', '--repo', 'repo']],
    ['a --repo with a third segment', [VERSION, '--pr', '1', '--repo', 'o/r/x']],
    ['a --repo with a space', [VERSION, '--pr', '1', '--repo', 'o/r x']],
    ['an invalid --repo with an empty --pr', [VERSION, '--pr', '', '--repo', 'repo']],
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
