import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import * as path from 'node:path';
import { createAttachmentStore } from '../../src/adapters/fs/attachment-store.ts';
import { createAttachmentService, type AttachInput } from '../../src/commands/attachment.ts';
import type { AttachmentPut, AttachmentStore } from '../../src/ports.ts';
import { captureError, createTempDir } from '../helpers.ts';
import { refuse } from './register-fakes.ts';

const PROJECT = 'alpha';
const PUT: AttachmentPut = { hash: 'a'.repeat(64), bytes: 3, deduplicated: false };

/** Porta falsa: só conta as chamadas de gravação, que o serviço nunca deve fazer ao recusar. */
function fakeStore(): { store: AttachmentStore; puts: string[] } {
  const puts: string[] = [];
  const store: AttachmentStore = {
    putText: (_project, text) => (puts.push(`text:${text}`), PUT),
    putPath: (_project, file) => (puts.push(`path:${file}`), PUT),
    status: refuse,
    read: refuse,
  };
  return { store, puts };
}

function refusalOf(input: Omit<AttachInput, 'project'>) {
  const { store, puts } = fakeStore();
  const error = captureError(() =>
    createAttachmentService({ store }).attach({ project: PROJECT, ...input }),
  );
  return { error, puts };
}

describe('attach', () => {
  describe('when the service refuses before any port', () => {
    it.each([
      ['neither text nor path', {}, ''],
      ['text and path together', { text: 'x', path: 'a.md' }, ''],
      ['empty text together with path', { text: '', path: 'a.md' }, ''],
      ['a path with NUL', { path: 'a\0b.md' }, '/path'],
      ['empty text', { text: '' }, '/text'],
    ] as const)('should reject with bad-args for %s', (_name, input, pointer) => {
      const { error, puts } = refusalOf(input);

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: pointer, code: 'bad-args' }],
      });
      expect(puts).toEqual([]);
    });

    it.each([
      '.env',
      'dados.json',
      'app.log',
      'x.MD',
      'x.Txt',
      '.md',
      '.txt',
      'a/.md',
      'a/b',
      'x.md.bak',
      '',
    ])('should reject with bad-extension for the path %j', (candidate) => {
      const { error, puts } = refusalOf({ path: candidate });

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: '/path', code: 'bad-extension' }],
      });
      expect(puts).toEqual([]);
    });

    it.each(['\uD800', 'a\uD83D', '\uDC00b', 'a\uDE00\uD83D'])(
      'should reject with lone-surrogate for the text %j',
      (text) => {
        const { error, puts } = refusalOf({ text });

        expect(error).toMatchObject({
          code: 'INVALID_INPUT',
          details: [{ path: '/text', code: 'lone-surrogate' }],
        });
        expect(puts).toEqual([]);
      },
    );
  });

  describe('when more than one refusal applies', () => {
    it('should let neither or both of text and path win over the path extension', () => {
      const { error } = refusalOf({ text: 'x', path: '.env' });

      expect(error.details).toMatchObject([{ path: '', code: 'bad-args' }]);
    });

    it('should let a NUL in the path win over the extension', () => {
      const { error } = refusalOf({ path: 'a\0.json' });

      expect(error.details).toMatchObject([{ path: '/path', code: 'bad-args' }]);
    });

    it('should let a segment that is too long win over the extension', () => {
      const { error } = refusalOf({ path: `${'a'.repeat(300)}.json` });

      expect(error.details).toMatchObject([{ path: '/path', code: 'bad-args' }]);
    });

    it('should check the NUL before the long segment, with the same code and the NUL message', () => {
      const { error } = refusalOf({ path: `${'a'.repeat(300)}\0.md` });

      expect(error.message).toBe('path contains NUL');
    });

    it('should report only the first refusal: a wrong extension on a path outside the cwd is bad-extension', () => {
      const { error } = refusalOf({ path: '../../etc/passwd' });

      expect(error.details).toMatchObject([{ path: '/path', code: 'bad-extension' }]);
    });
  });

  describe('with the 255-byte UTF-8 cap per path segment', () => {
    const at255 = [
      ['an ASCII segment at the cap', `${'a'.repeat(252)}.md`],
      ['a multibyte segment at the cap (126 × 2 bytes)', `${'é'.repeat(126)}.md`],
      ['a directory segment at the cap', `${'d'.repeat(255)}/x.md`],
    ] as const;
    const above255 = [
      ['an ASCII segment above the cap', `${'a'.repeat(253)}.md`],
      [
        'a multibyte segment above the cap (127 × 2 bytes, only 130 characters)',
        `${'é'.repeat(127)}.md`,
      ],
      ['a directory segment above the cap', `${'d'.repeat(256)}/x.md`],
      ['a long segment in the middle of an absolute path', `/a/${'d'.repeat(300)}/b/x.md`],
    ] as const;

    it.each(at255)('should accept %s', (_name, candidate) => {
      const { store, puts } = fakeStore();

      createAttachmentService({ store }).attach({ project: PROJECT, path: candidate });

      expect(puts).toEqual([`path:${candidate}`]);
    });

    it.each(above255)(
      'should reject %s with bad-args without calling the port',
      (_name, candidate) => {
        const { error, puts } = refusalOf({ path: candidate });

        expect(error).toMatchObject({
          code: 'INVALID_INPUT',
          details: [{ path: '/path', code: 'bad-args' }],
        });
        expect(puts).toEqual([]);
      },
    );
  });

  describe('when the input is accepted', () => {
    it.each(['a.md', 'a.txt', '.omc/plans/x.md', '/abs/dir/notas.txt', 'a.b.md', '..md'])(
      'should pass the path %j to the port as it came',
      (candidate) => {
        const { store, puts } = fakeStore();

        const result = createAttachmentService({ store }).attach({
          project: PROJECT,
          path: candidate,
        });

        expect(result).toEqual(PUT);
        expect(puts).toEqual([`path:${candidate}`]);
      },
    );

    it.each(['x', 'Decisão — ação\n', '😀 par válido', '😀'])(
      'should pass the text %j to the port as it came',
      (text) => {
        const { store, puts } = fakeStore();

        const result = createAttachmentService({ store }).attach({ project: PROJECT, text });

        expect(result).toEqual(PUT);
        expect(puts).toEqual([`text:${text}`]);
      },
    );
  });

  describe('with the real attachment store', () => {
    let base: string;
    let dataDir: string;
    let cwd: string;

    beforeEach(() => {
      base = createTempDir('attachment-service');
      dataDir = path.join(base, 'data');
      cwd = path.join(base, 'cwd');
      fs.mkdirSync(path.join(cwd, '.omc', 'plans'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    function service() {
      return createAttachmentService({ store: createAttachmentStore({ dataDir, cwd }) });
    }

    it('should store the exact bytes of a .md and a .txt path in the cwd', () => {
      fs.writeFileSync(path.join(cwd, '.omc', 'plans', 'x.md'), 'plano\r\n');
      fs.writeFileSync(path.join(cwd, 'notas.txt'), 'notas');

      const plan = service().attach({ project: PROJECT, path: '.omc/plans/x.md' });
      const notes = service().attach({ project: PROJECT, path: 'notas.txt' });

      expect(plan.bytes).toBe(7);
      expect(notes.bytes).toBe(5);
      expect(plan.hash).not.toBe(notes.hash);
    });

    it('should reject a .json inside <D> with bad-extension', () => {
      const inside = path.join(dataDir, 'x');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(`${inside}.json`, '{}');
      const insideCwd = createAttachmentService({
        store: createAttachmentStore({ dataDir, cwd: base }),
      });

      const json = captureError(() =>
        insideCwd.attach({ project: PROJECT, path: `${inside}.json` }),
      );

      expect(json.details).toMatchObject([{ path: '/path', code: 'bad-extension' }]);
    });

    it('should reject a .md inside <D> with inside-data-dir', () => {
      const inside = path.join(dataDir, 'x');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(`${inside}.md`, 'x');
      const insideCwd = createAttachmentService({
        store: createAttachmentStore({ dataDir, cwd: base }),
      });

      const md = captureError(() => insideCwd.attach({ project: PROJECT, path: `${inside}.md` }));

      expect(md.details).toMatchObject([{ path: '/path', code: 'inside-data-dir' }]);
    });

    it('should create nothing in <D> when the service refuses', () => {
      captureError(() => service().attach({ project: PROJECT, path: '.env' }));
      captureError(() => service().attach({ project: PROJECT, text: '' }));

      expect(fs.existsSync(dataDir)).toBe(false);
    });
  });
});
