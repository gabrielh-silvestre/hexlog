import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { createTempDir } from './helpers.ts';

const HOOK = path.resolve(__dirname, '..', '.husky', 'pre-push');
const ZERO = '0'.repeat(40);
const SHA = 'a'.repeat(40);
const PUSH_TIMEOUT = 15_000;

describe('.husky/pre-push', () => {
  let dir: string;
  let callsFile: string;

  // `npm` falso no PATH: o hook só importa quais comandos ele dispara, não o resultado deles.
  beforeEach(() => {
    dir = createTempDir('pre-push');
    callsFile = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${callsFile}"\n`, {
      mode: 0o755,
    });
  });

  const push = (...refs: string[]): { status: number | null; calls: string[] } => {
    const result = spawnSync('sh', [HOOK, 'origin', 'url'], {
      cwd: dir,
      input: refs.join('\n') + '\n',
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}` },
      timeout: PUSH_TIMEOUT,
    });
    const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n') : [];
    return { status: result.status, calls: calls.filter((call) => call !== '') };
  };

  it(
    'should run the coverage on the first push of a branch',
    () => {
      const result = push(`refs/heads/feat ${SHA} refs/heads/feat ${ZERO}`);

      expect(result.status).toBe(0);
      expect(result.calls).toEqual(['run test:coverage']);
    },
    PUSH_TIMEOUT,
  );

  it(
    'should run the coverage once when two new branches are pushed together',
    () => {
      const result = push(
        `refs/heads/a ${SHA} refs/heads/a ${ZERO}`,
        `refs/heads/b ${SHA} refs/heads/b ${ZERO}`,
      );

      expect(result.status).toBe(0);
      expect(result.calls.filter((call) => call === 'run test:coverage')).toHaveLength(1);
    },
    PUSH_TIMEOUT,
  );

  it(
    'should skip a push to a branch that already exists on the remote',
    () => {
      const result = push(`refs/heads/feat ${SHA} refs/heads/feat ${'b'.repeat(40)}`);

      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
    },
    PUSH_TIMEOUT,
  );

  it(
    'should skip a tag push',
    () => {
      const result = push(`refs/tags/v1.0.0 ${SHA} refs/tags/v1.0.0 ${ZERO}`);

      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
    },
    PUSH_TIMEOUT,
  );

  it(
    'should skip the deletion of a remote branch',
    () => {
      const result = push(`(delete) ${ZERO} refs/heads/feat ${SHA}`);

      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
    },
    PUSH_TIMEOUT,
  );

  it(
    'should treat an all-zero SHA-256 remote as a new branch',
    () => {
      const result = push(`refs/heads/feat ${'a'.repeat(64)} refs/heads/feat ${'0'.repeat(64)}`);

      expect(result.calls).toEqual(['run test:coverage']);
    },
    PUSH_TIMEOUT,
  );
});
