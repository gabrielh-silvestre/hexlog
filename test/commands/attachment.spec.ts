import { beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import * as path from 'node:path';
import { createAttachmentStore } from '../../src/adapters/fs/attachment-store.ts';
import { createAttachmentService, type AttachInput } from '../../src/commands/attachment.ts';
import { sha256hex } from '../../src/domain/chain.ts';
import type { AttachmentPut, AttachmentStore } from '../../src/ports.ts';
import { captureError, createTempDir } from '../helpers.ts';
import { PROJECT, refuse } from './fakes.ts';

const PUT: AttachmentPut = { hash: 'a'.repeat(64), bytes: 3, deduplicated: false };

/** Porta falsa: só conta as chamadas de gravação, que o serviço nunca deve fazer ao recusar. */
function fakeStore(): { store: AttachmentStore; puts: string[] } {
  const puts: string[] = [];
  const store: AttachmentStore = {
    putText: (_project, text) => {
      puts.push(`text:${text}`);
      return PUT;
    },
    putPath: (_project, file) => {
      puts.push(`path:${file}`);
      return PUT;
    },
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

/** Segmentos de exatamente 255 bytes UTF-8, o teto que a porta aceita. */
const AT_255: [string, string][] = [
  ['an ASCII segment at the cap', `${'a'.repeat(252)}.md`],
  ['a multibyte segment at the cap (126 × 2 bytes)', `${'é'.repeat(126)}.md`],
  ['a directory segment at the cap', `${'d'.repeat(255)}/x.md`],
];

const ACCEPTED_PATHS: [string, string][] = [
  ...['a.md', 'a.txt', '.omc/plans/x.md', '/abs/dir/notes.txt', 'a.b.md', '..md'].map(
    (candidate): [string, string] => [`the path ${candidate}`, candidate],
  ),
  ...AT_255,
];

describe('attach', () => {
  describe('when the service refuses before any port', () => {
    it.each([
      ['neither text nor path', {}, ''],
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
      'data.json',
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
    it.each([
      [
        'text and path together with a wrong extension',
        { text: 'x', path: '.env' },
        '',
        'bad-args',
      ],
      ['a NUL in a path with a wrong extension', { path: 'a\0.json' }, '/path', 'bad-args'],
      [
        'a segment that is too long in a path with a wrong extension',
        { path: `${'a'.repeat(300)}.json` },
        '/path',
        'bad-args',
      ],
      [
        'a wrong extension on a path outside the cwd',
        { path: '../../etc/passwd' },
        '/path',
        'bad-extension',
      ],
    ] as const)('should report only the first refusal for %s', (_name, input, pointer, code) => {
      const { error } = refusalOf(input);

      expect(error.details).toMatchObject([{ path: pointer, code }]);
    });

    it('should check the NUL before the long segment, with the same code and the NUL message', () => {
      const { error } = refusalOf({ path: `${'a'.repeat(300)}\0.md` });

      expect(error.message).toBe('path contains NUL');
    });
  });

  describe('with the 255-byte UTF-8 cap per path segment', () => {
    it.each([
      ['an ASCII segment above the cap', `${'a'.repeat(253)}.md`],
      [
        'a multibyte segment above the cap (127 × 2 bytes, only 130 characters)',
        `${'é'.repeat(127)}.md`,
      ],
      ['a directory segment above the cap', `${'d'.repeat(256)}/x.md`],
      ['a long segment in the middle of an absolute path', `/a/${'d'.repeat(300)}/b/x.md`],
    ])('should reject %s with bad-args without calling the port', (_name, candidate) => {
      const { error, puts } = refusalOf({ path: candidate });

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path: '/path', code: 'bad-args' }],
      });
      expect(puts).toEqual([]);
    });
  });

  describe('when the input is accepted', () => {
    it.each(ACCEPTED_PATHS)('should pass %s to the port as it came', (_name, candidate) => {
      const { store, puts } = fakeStore();

      const result = createAttachmentService({ store }).attach({
        project: PROJECT,
        path: candidate,
      });

      expect(result).toEqual(PUT);
      expect(puts).toEqual([`path:${candidate}`]);
    });

    it.each(['x', 'Decisão — ação\n', '😀 valid pair', '😀'])(
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

    function service() {
      return createAttachmentService({ store: createAttachmentStore({ dataDir, cwd }) });
    }

    it.each([
      ['.omc/plans/x.md', 'plan\r\n'],
      ['notes.txt', 'notes'],
    ])('should store the exact bytes of the path %s in the cwd', (file, content) => {
      fs.writeFileSync(path.join(cwd, file), content);

      const result = service().attach({ project: PROJECT, path: file });

      expect(result).toEqual({
        hash: sha256hex(content),
        bytes: Buffer.byteLength(content),
        deduplicated: false,
      });
    });

    it.each([
      ['.json', 'bad-extension'],
      ['.md', 'inside-data-dir'],
    ])('should reject a %s file inside <D> with %s', (extension, code) => {
      const inside = `${path.join(dataDir, 'x')}${extension}`;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(inside, 'x');
      const insideCwd = createAttachmentService({
        store: createAttachmentStore({ dataDir, cwd: base }),
      });

      const error = captureError(() => insideCwd.attach({ project: PROJECT, path: inside }));

      expect(error.details).toMatchObject([{ path: '/path', code }]);
    });

    it('should create nothing in <D> when the service refuses', () => {
      captureError(() => service().attach({ project: PROJECT, path: '.env' }));
      captureError(() => service().attach({ project: PROJECT, text: '' }));

      expect(fs.existsSync(dataDir)).toBe(false);
    });
  });
});
