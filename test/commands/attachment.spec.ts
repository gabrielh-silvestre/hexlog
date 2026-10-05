import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
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

describe('attach: recusas do serviço, antes de qualquer porta', () => {
  test.each([
    ['nenhum de text/path', {}, ''],
    ['text e path juntos', { text: 'x', path: 'a.md' }, ''],
    ['text vazio junto com path', { text: '', path: 'a.md' }, ''],
    ['path com NUL', { path: 'a\0b.md' }, '/path'],
    ['text vazio', { text: '' }, '/text'],
  ] as const)('bad-args: %s', (_name, input, pointer) => {
    const { error, puts } = refusalOf(input);

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ path: pointer, code: 'bad-args' }],
    });
    expect(puts).toEqual([]);
  });

  test.each([
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
  ])('bad-extension: %j', (candidate) => {
    const { error, puts } = refusalOf({ path: candidate });

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ path: '/path', code: 'bad-extension' }],
    });
    expect(puts).toEqual([]);
  });

  test.each(['\uD800', 'a\uD83D', '\uDC00b', 'a\uDE00\uD83D'])(
    'surrogate solto no text: %j',
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

describe('attach: ordem das recusas (D-15)', () => {
  test('nenhum/ambos vence a extensão do path', () => {
    const { error } = refusalOf({ text: 'x', path: '.env' });

    expect(error.details).toMatchObject([{ path: '', code: 'bad-args' }]);
  });

  test('NUL no path vence a extensão', () => {
    const { error } = refusalOf({ path: 'a\0.json' });

    expect(error.details).toMatchObject([{ path: '/path', code: 'bad-args' }]);
  });

  test('segmento longo demais vence a extensão', () => {
    const { error } = refusalOf({ path: `${'a'.repeat(300)}.json` });

    expect(error.details).toMatchObject([{ path: '/path', code: 'bad-args' }]);
  });

  test('NUL vem antes do segmento longo (mesmo código, mensagem do NUL)', () => {
    const { error } = refusalOf({ path: `${'a'.repeat(300)}\0.md` });

    expect(error.message).toBe('path contains NUL');
  });

  test('só a primeira recusa sai: a extensão errada em caminho fora do cwd é bad-extension', () => {
    const { error } = refusalOf({ path: '../../etc/passwd' });

    expect(error.details).toMatchObject([{ path: '/path', code: 'bad-extension' }]);
  });
});

describe('attach: teto de 255 bytes UTF-8 por segmento do path', () => {
  const at255 = [
    ['ASCII no teto', `${'a'.repeat(252)}.md`],
    ['multibyte no teto (126 × 2 bytes)', `${'é'.repeat(126)}.md`],
    ['diretório no teto', `${'d'.repeat(255)}/x.md`],
  ] as const;
  const above255 = [
    ['ASCII acima do teto', `${'a'.repeat(253)}.md`],
    ['multibyte acima do teto (127 × 2 bytes, só 130 caracteres)', `${'é'.repeat(127)}.md`],
    ['diretório acima do teto', `${'d'.repeat(256)}/x.md`],
    ['segmento longo no meio de caminho absoluto', `/a/${'d'.repeat(300)}/b/x.md`],
  ] as const;

  test.each(at255)('%s passa', (_name, candidate) => {
    const { store, puts } = fakeStore();

    createAttachmentService({ store }).attach({ project: PROJECT, path: candidate });

    expect(puts).toEqual([`path:${candidate}`]);
  });

  test.each(above255)('%s é bad-args sem chamar a porta', (_name, candidate) => {
    const { error, puts } = refusalOf({ path: candidate });

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ path: '/path', code: 'bad-args' }],
    });
    expect(puts).toEqual([]);
  });
});

describe('attach: entrada aceita chega à porta', () => {
  test.each(['a.md', 'a.txt', '.omc/plans/x.md', '/abs/dir/notas.txt', 'a.b.md', '..md'])(
    'path %j é repassado como veio',
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

  test.each(['x', 'Decisão — ação\n', '😀 par válido', '😀'])(
    'text %j é repassado como veio',
    (text) => {
      const { store, puts } = fakeStore();

      const result = createAttachmentService({ store }).attach({ project: PROJECT, text });

      expect(result).toEqual(PUT);
      expect(puts).toEqual([`text:${text}`]);
    },
  );
});

describe('attach sobre o adaptador real', () => {
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

  test('path .md e .txt em subpasta do cwd gravam os bytes exatos', () => {
    fs.writeFileSync(path.join(cwd, '.omc', 'plans', 'x.md'), 'plano\r\n');
    fs.writeFileSync(path.join(cwd, 'notas.txt'), 'notas');

    const plan = service().attach({ project: PROJECT, path: '.omc/plans/x.md' });
    const notes = service().attach({ project: PROJECT, path: 'notas.txt' });

    expect(plan.bytes).toBe(7);
    expect(notes.bytes).toBe(5);
    expect(plan.hash).not.toBe(notes.hash);
  });

  test('.json dentro de <D> dá bad-extension, e .md dentro de <D> dá inside-data-dir', () => {
    const inside = path.join(dataDir, 'x');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${inside}.json`, '{}');
    fs.writeFileSync(`${inside}.md`, 'x');
    const insideCwd = createAttachmentService({
      store: createAttachmentStore({ dataDir, cwd: base }),
    });

    const json = captureError(() => insideCwd.attach({ project: PROJECT, path: `${inside}.json` }));
    const md = captureError(() => insideCwd.attach({ project: PROJECT, path: `${inside}.md` }));

    expect(json.details).toMatchObject([{ path: '/path', code: 'bad-extension' }]);
    expect(md.details).toMatchObject([{ path: '/path', code: 'inside-data-dir' }]);
  });

  test('recusa do serviço não cria nada em <D>', () => {
    captureError(() => service().attach({ project: PROJECT, path: '.env' }));
    captureError(() => service().attach({ project: PROJECT, text: '' }));

    expect(fs.existsSync(dataDir)).toBe(false);
  });
});
