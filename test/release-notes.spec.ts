import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { releaseNotes } from '../scripts/release-notes.ts';
import { VERSION } from '../src/version.ts';
import { createTempDir } from './helpers.ts';

const repoRoot = path.resolve(__dirname, '..');
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
  describe('with an opening paragraph and subsections', () => {
    const body = releaseNotes(CHANGELOG, '2.0.0', PR);

    it('should put the opening paragraph before the PR line', () => {
      expect(body.indexOf('Summary of 2.0.0.')).toBeLessThan(body.indexOf(PR_LINE));
    });

    it('should put the PR line before the subsections', () => {
      expect(body.indexOf(PR_LINE)).toBeLessThan(body.indexOf('## Added'));
    });

    it('should put the subsections before the install block', () => {
      expect(body.indexOf('## Migration')).toBeLessThan(body.indexOf('## Instalação'));
    });

    it('should end with the install block', () => {
      expect(body.lastIndexOf('\n## ')).toBe(body.indexOf('\n## Instalação'));
    });

    it('should carry the install check command', () => {
      expect(body).toContain('node scripts/install.ts --check');
    });

    it('should demote ### to ## outside code fences', () => {
      expect(body).not.toMatch(/^### (Added|Migration)/m);
    });

    it('should keep ### inside code fences', () => {
      expect(body).toContain('\n### not a heading\n');
    });

    it('should not include the next version section', () => {
      expect(body).not.toContain('Old thing');
    });

    it('should not include the Unreleased section', () => {
      expect(body).not.toContain('Unreleased');
    });
  });

  it('should put only the PR line before the subsections when there is no opening paragraph', () => {
    expect(releaseNotes(CHANGELOG, '1.0.0', PR).startsWith(`${PR_LINE}\n\n## Added`)).toBe(true);
  });

  it('should omit the PR line when there is no PR', () => {
    expect(releaseNotes(CHANGELOG, '2.0.0')).not.toContain('PR da release');
  });

  it('should start with the opening paragraph when there is no PR', () => {
    expect(releaseNotes(CHANGELOG, '2.0.0').startsWith('Summary of 2.0.0.\n\n## Added')).toBe(true);
  });

  it('should keep the paragraph of a section with an opening paragraph and no subsection', () => {
    const only = releaseNotes('## [3.0.0] - 2026-12-01\n\nOnly a summary.\n', '3.0.0');

    expect(only.startsWith('Only a summary.\n\n## Instalação')).toBe(true);
  });

  it('should throw for a missing version', () => {
    expect(() => releaseNotes(CHANGELOG, '9.9.9')).toThrow('no section for 9.9.9');
  });

  it('should not match another section by a version prefix', () => {
    expect(() => releaseNotes(CHANGELOG, '2.0')).toThrow('no section for 2.0');
  });

  it('should throw for an empty section', () => {
    expect(() => releaseNotes('## [4.0.0] - 2027-01-01\n\n## [3.0.0]\n- x\n', '4.0.0')).toThrow(
      'is empty',
    );
  });

  describe('with code fences', () => {
    it.each([
      ['a backtick fence', '```sh', '```'],
      ['a tilde fence', '~~~', '~~~'],
      ['a fence indented by three spaces', '   ```', '   ```'],
      ['a closing fence longer than the opening one', '```', '`````'],
    ])('should keep a section heading inside %s in the section', (_name, open, close) => {
      const notes = releaseNotes(sectionWithFence(open, close), '5.0.0');

      expect(notes).toContain('## inside the fence');
      expect(notes).toContain('- Real thing.');
      expect(notes).not.toContain('Older thing');
    });

    it('should neither demote nor take as the first subsection a ### inside a fence', () => {
      const notes = releaseNotes(sectionWithFence('~~~', '~~~'), '5.0.0');

      expect(notes).toContain('\n### also inside the fence\n');
      expect(notes.startsWith('Summary of 5.0.0.\n\n~~~\n## inside the fence')).toBe(true);
      expect(notes).toContain('\n\n## Added\n');
    });

    it('should not close a longer fence with a shorter fence line', () => {
      const notes = releaseNotes(sectionWithFence('````', '```\n````'), '5.0.0');

      expect(notes).toContain('\n### also inside the fence\n');
      expect(notes).not.toContain('Older thing');
    });

    it('should not close the fence with a closing line that has text after it', () => {
      const notes = releaseNotes(sectionWithFence('```', '``` text\n```'), '5.0.0');

      expect(notes).toContain('\n### also inside the fence\n');
      expect(notes).toContain('- Real thing.');
    });

    it('should not take a backtick line whose info string has a backtick as a fence', () => {
      const changelog = ['## [6.0.0] - 2027-03-01', '', '```a`b', '### Added', '- x'].join('\n');

      expect(releaseNotes(changelog, '6.0.0')).toContain('\n## Added\n');
    });

    it('should keep the rest of the changelog in the section when a fence is never closed', () => {
      const changelog = [
        '## [6.0.0] - 2027-03-01',
        '',
        'Summary.',
        '',
        '```sh',
        '## [5.0.0] - 2027-02-01',
        '- Older thing.',
      ].join('\n');

      const notes = releaseNotes(changelog, '6.0.0');

      expect(notes).toContain('## [5.0.0] - 2027-02-01\n- Older thing.');
    });

    it('should take a fence indented by four spaces as indented code, not a fence', () => {
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

describe('scripts/release-notes-cli.ts', () => {
  const CLI_TIMEOUT = 15_000;
  const cli = path.join(repoRoot, 'scripts', 'release-notes-cli.ts');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: CLI_TIMEOUT });

  it(
    'should print the body of the package.json version from the real CHANGELOG.md',
    () => {
      const result = run(VERSION, '--pr', '12', '--repo', 'o/r');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('PR da release: [#12](https://github.com/o/r/pull/12)');
      expect(result.stdout).toContain('## Instalação');
    },
    CLI_TIMEOUT,
  );

  // Sem `node_modules`: o `release.yml` roda a CLI sem `npm ci`, então um import de pacote quebra a release
  it(
    'should run without node_modules, as the release workflow does',
    () => {
      const root = createTempDir('release-notes-bare');
      fs.mkdirSync(path.join(root, 'scripts'));
      for (const file of ['release-notes.ts', 'release-notes-cli.ts']) {
        fs.copyFileSync(path.join(repoRoot, 'scripts', file), path.join(root, 'scripts', file));
      }
      fs.copyFileSync(path.join(repoRoot, 'CHANGELOG.md'), path.join(root, 'CHANGELOG.md'));

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

  it(
    'should omit the PR line for an empty --pr with a valid --repo, as the release workflow passes them',
    () => {
      const result = run(VERSION, '--pr', '', '--repo', 'o/r');

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('PR da release');
    },
    CLI_TIMEOUT,
  );

  it.each([
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
    'should reject %s with exit 1',
    (_name, args) => {
      const result = run(...args);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('release-notes failed');
    },
    CLI_TIMEOUT,
  );

  it(
    'should exit 1 for an unknown version',
    () => {
      const result = run('0.0.0');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no section for 0.0.0');
    },
    CLI_TIMEOUT,
  );
});
