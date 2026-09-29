import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { execFileSync, spawn } from 'node:child_process';
// import default (não `* as fs`): precisa ser o mesmo objeto que src/attachments.ts usa, para
// jest.spyOn interceptar de fato a chamada feita lá dentro (ver comentário em src/attachments.ts).
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ATTACHMENT_MAX_BYTES,
  checkAttachment,
  checkAttachmentMemoized,
  putAttachmentPath,
  putAttachmentText,
  readAttachmentPage,
} from '../src/attachments.ts';
import { sha256hex } from '../src/chain.ts';
import { sliceChars } from '../src/pages.ts';
import { captureError } from './helpers.ts';

const PROJECT = 'alpha';
const PLAN = '.omc/plans/plano.md';
// mtime inteiro em segundos: `utimes` com sub-milissegundo perderia precisão e o teste não reproduziria o mtime.
const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z');

let dataDir: string;
let cwd: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-att-data-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-att-cwd-'));
  fs.mkdirSync(path.join(dataDir, PROJECT));
  fs.mkdirSync(path.join(cwd, '.omc', 'plans'), { recursive: true });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function blobPath(hash: string): string {
  return path.join(dataDir, PROJECT, 'attachments', hash);
}

function writePlan(content: string | Buffer, name = 'plano.md'): string {
  const file = path.join(cwd, '.omc', 'plans', name);
  fs.writeFileSync(file, content);
  return file;
}

/** Concatena as páginas de `limit` caracteres até `nextOffset` ser `null`. */
function readAll(hash: string, limit: number): string {
  let text = '';
  let offset = 0;
  for (;;) {
    const page = readAttachmentPage(dataDir, PROJECT, hash, offset, limit);
    text += page.text;
    if (page.nextOffset === null) return text;
    offset = page.nextOffset;
  }
}

/** Códigos de `details` do INVALID_INPUT lançado por `fn`. */
function invalidInputDetails(fn: () => unknown): string[] {
  const error = captureError(fn);
  expect(error.code).toBe('INVALID_INPUT');
  return error.details.map((detail) => detail.code);
}

const SAMPLES: [string, string][] = [
  ['pt-BR', 'Decisão: não há ação — coração\n'],
  ['emoji', 'ok 😀 e 🚀 fim'],
  ['CRLF', 'linha 1\r\nlinha 2\r\n'],
  ['BOM', '\uFEFFcom BOM'],
  ['NUL', 'antes\u0000depois'],
];

describe('S1: put e get byte-idênticos', () => {
  test.each(SAMPLES)(
    '%s: por text e por path o hash é o sha256 dos bytes e o get devolve o original',
    (_name, text) => {
      const byText = putAttachmentText(dataDir, PROJECT, text);
      expect(byText).toEqual({
        hash: sha256hex(text),
        bytes: Buffer.byteLength(text, 'utf8'),
        deduplicated: false,
      });

      writePlan(text);
      const byPath = putAttachmentPath(dataDir, PROJECT, cwd, PLAN);
      expect(byPath).toEqual({ ...byText, deduplicated: true });

      expect(readAll(byText.hash, 5)).toBe(text);
      expect(readAttachmentPage(dataDir, PROJECT, byText.hash, 0, 24_000)).toEqual({
        hash: byText.hash,
        bytes: byText.bytes,
        total: text.length,
        offset: 0,
        text,
        nextOffset: null,
      });
    },
  );

  test('mesmo texto → mesmo hash, deduplicated e um só arquivo no disco', () => {
    putAttachmentText(dataDir, PROJECT, 'igual');
    expect(putAttachmentText(dataDir, PROJECT, 'igual').deduplicated).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, PROJECT, 'attachments'))).toEqual([
      sha256hex('igual'),
    ]);
  });

  test('blob com modo 0o600 e diretório 0o700', () => {
    const { hash } = putAttachmentText(dataDir, PROJECT, 'privado');
    expect(fs.statSync(blobPath(hash)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(blobPath(hash))).mode & 0o777).toBe(0o700);
  });

  test('8 puts concorrentes de processos distintos → exatamente um deduplicated:false e um só blob', async () => {
    const module = pathToFileURL(path.resolve(__dirname, '../src/attachments.ts')).href;
    const script =
      `const m = await import(${JSON.stringify(module)});` +
      `console.log(JSON.stringify(m.putAttachmentText(${JSON.stringify(dataDir)}, ${JSON.stringify(PROJECT)}, 'corrida')));`;

    const runs = Array.from(
      { length: 8 },
      () =>
        new Promise<{ deduplicated: boolean }>((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
          let out = '';
          child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0
              ? resolve(JSON.parse(out) as { deduplicated: boolean })
              : reject(new Error(`exit ${code}`)),
          );
        }),
    );
    const results = await Promise.all(runs);

    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect(fs.readdirSync(path.join(dataDir, PROJECT, 'attachments'))).toEqual([
      sha256hex('corrida'),
    ]);
  }, 30_000);

  test('put do mesmo texto sobre blob adulterado → ATTACHMENT_CORRUPTED, sem sobrescrever', () => {
    const { hash } = putAttachmentText(dataDir, PROJECT, 'original');
    fs.writeFileSync(blobPath(hash), 'adulterad');

    expect(captureError(() => putAttachmentText(dataDir, PROJECT, 'original')).code).toBe(
      'ATTACHMENT_CORRUPTED',
    );
    expect(fs.readFileSync(blobPath(hash), 'utf8')).toBe('adulterad');
  });
});

describe('S1: limites e erros do put por text', () => {
  test('o teto é 1 MiB em bytes, não em caracteres', () => {
    expect(putAttachmentText(dataDir, PROJECT, 'a'.repeat(ATTACHMENT_MAX_BYTES)).bytes).toBe(
      ATTACHMENT_MAX_BYTES,
    );
    expect(
      invalidInputDetails(() =>
        putAttachmentText(dataDir, PROJECT, 'a'.repeat(ATTACHMENT_MAX_BYTES + 1)),
      ),
    ).toEqual(['too_big']);
    // 700.000 caracteres passam em caracteres e estouram em bytes (2 bytes cada).
    expect(
      invalidInputDetails(() => putAttachmentText(dataDir, PROJECT, 'é'.repeat(700_000))),
    ).toEqual(['too_big']);
  });

  test('texto vazio → INVALID_INPUT bad_args', () => {
    expect(invalidInputDetails(() => putAttachmentText(dataDir, PROJECT, ''))).toEqual([
      'bad_args',
    ]);
  });

  test.each(['\ud800', 'x\udc00y', 'par quebrado \ud83d'])(
    'surrogate solto %j → INVALID_INPUT lone_surrogate',
    (text) => {
      expect(invalidInputDetails(() => putAttachmentText(dataDir, PROJECT, text))).toEqual([
        'lone_surrogate',
      ]);
    },
  );

  test('projeto inexistente → PROJECT_NOT_FOUND, sem criar diretório', () => {
    expect(captureError(() => putAttachmentText(dataDir, 'ghost', 'x')).code).toBe(
      'PROJECT_NOT_FOUND',
    );
    expect(captureError(() => putAttachmentPath(dataDir, 'ghost', cwd, PLAN)).code).toBe(
      'PROJECT_NOT_FOUND',
    );
    expect(fs.existsSync(path.join(dataDir, 'ghost'))).toBe(false);
  });
});

describe('Q1: put por path restrito a <cwd>/.omc/plans/*.md', () => {
  test('caminho absoluto e relativo ao cwd chegam ao mesmo blob', () => {
    const file = writePlan('plano');
    const relative = putAttachmentPath(dataDir, PROJECT, cwd, PLAN);
    const absolute = putAttachmentPath(dataDir, PROJECT, cwd, file);
    expect(absolute).toEqual({ ...relative, deduplicated: true });
  });

  test('NUL no caminho → bad_args', () => {
    expect(
      invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, '.omc/plans/a\0.md')),
    ).toEqual(['bad_args']);
  });

  test('extensão diferente de .md → not_md', () => {
    writePlan('x', 'plano.txt');
    expect(
      invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, '.omc/plans/plano.txt')),
    ).toEqual(['not_md']);
  });

  test('diretório diferente de <cwd>/.omc/plans → outside_allowed_root', () => {
    fs.writeFileSync(path.join(cwd, 'solto.md'), 'x');
    expect(invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, 'solto.md'))).toEqual(
      ['outside_allowed_root'],
    );
    expect(
      invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, '.omc/plans/../solto.md')),
    ).toEqual(['outside_allowed_root']);
  });

  test('.omc/plans como symlink para fora → outside_allowed_root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-att-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'plano.md'), 'fora');
      fs.rmSync(path.join(cwd, '.omc', 'plans'), { recursive: true });
      fs.symlinkSync(outside, path.join(cwd, '.omc', 'plans'));
      expect(invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, PLAN))).toEqual([
        'outside_allowed_root',
      ]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('symlink no componente final → not_regular', () => {
    fs.writeFileSync(path.join(cwd, 'alvo.md'), 'alvo');
    fs.symlinkSync(path.join(cwd, 'alvo.md'), path.join(cwd, '.omc', 'plans', 'link.md'));
    expect(
      invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, '.omc/plans/link.md')),
    ).toEqual(['not_regular']);
  });

  test('diretório e FIFO chamados *.md → not_regular', () => {
    fs.mkdirSync(path.join(cwd, '.omc', 'plans', 'pasta.md'));
    expect(
      invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, '.omc/plans/pasta.md')),
    ).toEqual(['not_regular']);

    execFileSync('mkfifo', [path.join(cwd, '.omc', 'plans', 'fila.md')]);
    expect(
      invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, '.omc/plans/fila.md')),
    ).toEqual(['not_regular']);
  });

  test('arquivo maior que 1 MiB → too_big', () => {
    writePlan(Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));
    expect(invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, PLAN))).toEqual([
      'too_big',
    ]);
  });

  test('arquivo que cresce entre o fstat e a leitura → too_big', () => {
    writePlan(Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));
    const realFstat = fs.fstatSync.bind(fs);
    jest.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) =>
      Object.assign(Object.create(realFstat(fd) as object) as object, {
        size: 10,
      })) as unknown as typeof fs.fstatSync);

    expect(invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, PLAN))).toEqual([
      'too_big',
    ]);
  });

  test('bytes que não são UTF-8 válido → invalid_utf8; arquivo vazio → bad_args', () => {
    writePlan(Buffer.from([0x61, 0xff, 0xfe]));
    expect(invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, PLAN))).toEqual([
      'invalid_utf8',
    ]);

    writePlan('');
    expect(invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, PLAN))).toEqual([
      'bad_args',
    ]);
  });

  test('arquivo de 240 KB entra byte-idêntico', () => {
    const text = 'Decisão longa — ação\n'.repeat(11_000);
    writePlan(text);
    const { hash, bytes } = putAttachmentPath(dataDir, PROJECT, cwd, PLAN);
    expect(bytes).toBeGreaterThan(240_000);
    expect(readAll(hash, 24_000)).toBe(text);
  });
});

/** Erro de I/O como o do fs: `code` de errno e uma mensagem com o caminho absoluto. */
function fsError(code: string, file: string): Error {
  return Object.assign(new Error(`${code}: boom, open '${file}'`), { code });
}

/** Nada do que o erro devolve ao agente (mensagem e details) contém `secret`. */
function leaks(error: { message: string; details: unknown }, secret: string): boolean {
  return JSON.stringify([error.message, error.details]).includes(secret);
}

describe('Q1: put por path — corrida no diretório, hardlink e erros sem vazamento', () => {
  let outside: string;

  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-att-out-'));
    fs.writeFileSync(path.join(outside, 'plano.md'), 'fora');
  });

  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
  });

  /** Na 1ª chamada de `openSync` (a do arquivo do plano) troca `.omc/plans` por um symlink para `outside`. */
  function swapPlansDirectoryOnOpen(): void {
    const plans = path.join(cwd, '.omc', 'plans');
    const realOpen = fs.openSync.bind(fs);
    let swapped = false;
    jest.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(plans, `${plans}-original`);
        fs.symlinkSync(outside, plans);
      }
      return realOpen(...args);
    });
  }

  test('hardlink para arquivo de fora de .omc/plans → not_regular, sem gravar nada', () => {
    fs.writeFileSync(path.join(cwd, 'segredo.md'), 'segredo');
    fs.linkSync(path.join(cwd, 'segredo.md'), path.join(cwd, '.omc', 'plans', 'link.md'));

    expect(
      invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, '.omc/plans/link.md')),
    ).toEqual(['not_regular']);
    expect(fs.existsSync(path.join(dataDir, PROJECT, 'attachments'))).toBe(false);
  });

  test('diretório trocado por symlink entre o realpath e o open → outside_allowed_root, sem gravar', () => {
    swapPlansDirectoryOnOpen();

    expect(invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, PLAN))).toEqual([
      'outside_allowed_root',
    ]);
    expect(fs.existsSync(path.join(dataDir, PROJECT, 'attachments'))).toBe(false);
  });

  test('sem /proc/self/fd (macOS): a troca do diretório também é recusada', () => {
    const realRealpath = fs.realpathSync.bind(fs);
    jest.spyOn(fs, 'realpathSync').mockImplementation((target: fs.PathLike) => {
      if (String(target).startsWith('/proc/self/fd/')) throw fsError('ENOENT', String(target));
      return realRealpath(target);
    });
    swapPlansDirectoryOnOpen();

    expect(invalidInputDetails(() => putAttachmentPath(dataDir, PROJECT, cwd, PLAN))).toEqual([
      'outside_allowed_root',
    ]);
  });

  test('sem /proc/self/fd e sem troca, o put segue normalmente', () => {
    const realRealpath = fs.realpathSync.bind(fs);
    jest.spyOn(fs, 'realpathSync').mockImplementation((target: fs.PathLike) => {
      if (String(target).startsWith('/proc/self/fd/')) throw fsError('ENOENT', String(target));
      return realRealpath(target);
    });
    writePlan('plano normal');

    expect(putAttachmentPath(dataDir, PROJECT, cwd, PLAN).hash).toBe(sha256hex('plano normal'));
  });

  test('cwd sem .omc/plans (sessão em subdiretório) → outside_allowed_root, sem errno nem caminho', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-att-bare-'));
    try {
      const error = captureError(() => putAttachmentPath(dataDir, PROJECT, bare, PLAN));

      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details.map((detail) => detail.code)).toEqual(['outside_allowed_root']);
      expect(leaks(error, bare)).toBe(false);
      expect(leaks(error, 'ENOENT')).toBe(false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test('cwd removido e diretório inexistente → outside_allowed_root, também sem vazar o caminho', () => {
    const gone = path.join(os.tmpdir(), 'hexlog-att-gone-does-not-exist');
    const missingDirectory = captureError(() =>
      putAttachmentPath(dataDir, PROJECT, cwd, path.join(cwd, 'nao', 'existe', 'plano.md')),
    );
    const missingCwd = captureError(() => putAttachmentPath(dataDir, PROJECT, gone, PLAN));

    for (const error of [missingDirectory, missingCwd]) {
      expect(error.details.map((detail) => detail.code)).toEqual(['outside_allowed_root']);
    }
    expect(leaks(missingDirectory, cwd)).toBe(false);
    expect(leaks(missingCwd, gone)).toBe(false);
  });

  test('arquivo inexistente em .omc/plans → not_found, sem mensagem do fs nem caminho', () => {
    const error = captureError(() =>
      putAttachmentPath(dataDir, PROJECT, cwd, '.omc/plans/nao-existe.md'),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.map((detail) => detail.code)).toEqual(['not_found']);
    expect(leaks(error, cwd)).toBe(false);
    expect(leaks(error, 'ENOENT')).toBe(false);
  });

  test('erro de leitura do arquivo vira IO_ERROR sem o caminho absoluto', () => {
    const file = writePlan('conteúdo');
    jest.spyOn(fs, 'readSync').mockImplementation(() => {
      throw fsError('EIO', file);
    });

    const error = captureError(() => putAttachmentPath(dataDir, PROJECT, cwd, PLAN));

    expect(error.code).toBe('IO_ERROR');
    expect(error.details.map((detail) => detail.code)).toEqual(['EIO']);
    expect(leaks(error, cwd)).toBe(false);
  });
});

describe('Q2: leitura do blob não segue symlink nem aceita arquivo especial', () => {
  const HASH = sha256hex('conteudo');

  /** Diretório `attachments/` do projeto, criado sem nenhum blob. */
  function attachmentsDir(): string {
    const dir = path.join(dataDir, PROJECT, 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  test('symlink com o conteúdo certo → corrupted em checkAttachment, no memo e no get', () => {
    putAttachmentText(dataDir, PROJECT, 'conteudo');
    expect(checkAttachmentMemoized(dataDir, PROJECT, HASH)).toBe('ok');

    const copy = path.join(cwd, 'copia');
    fs.writeFileSync(copy, 'conteudo');
    fs.rmSync(blobPath(HASH));
    fs.symlinkSync(copy, blobPath(HASH));

    expect(checkAttachment(dataDir, PROJECT, HASH)).toBe('corrupted');
    expect(checkAttachmentMemoized(dataDir, PROJECT, HASH)).toBe('corrupted');
    expect(captureError(() => readAttachmentPage(dataDir, PROJECT, HASH, 0, 10)).code).toBe(
      'ATTACHMENT_CORRUPTED',
    );
  });

  test('FIFO, diretório e arquivo acima de 1 MiB no lugar do blob → corrupted, sem travar', () => {
    const dir = attachmentsDir();

    execFileSync('mkfifo', [path.join(dir, 'a'.repeat(64))]);
    fs.mkdirSync(path.join(dir, 'b'.repeat(64)));
    fs.writeFileSync(path.join(dir, 'c'.repeat(64)), Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));

    expect(['a', 'b', 'c'].map((c) => checkAttachment(dataDir, PROJECT, c.repeat(64)))).toEqual([
      'corrupted',
      'corrupted',
      'corrupted',
    ]);
  });
});

describe('S1: nome de projeto e erros de gravação', () => {
  test.each(['../x', 'A', 'a/b', ''])('nome de projeto %j → INVALID_INPUT bad_args', (project) => {
    expect(invalidInputDetails(() => putAttachmentText(dataDir, project, 'x'))).toEqual([
      'bad_args',
    ]);
    expect(
      invalidInputDetails(() => readAttachmentPage(dataDir, project, 'a'.repeat(64), 0, 10)),
    ).toEqual(['bad_args']);
  });

  test.each(['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync'] as const)(
    '%s falhando na gravação vira IO_ERROR, não Error cru',
    (method) => {
      jest.spyOn(fs as unknown as Record<string, () => unknown>, method).mockImplementation(() => {
        throw fsError('EIO', dataDir);
      });

      expect(captureError(() => putAttachmentText(dataDir, PROJECT, 'x')).code).toBe('IO_ERROR');
    },
  );

  test('depois do link, faz fsync do arquivo e do diretório attachments', () => {
    const fsync = jest.spyOn(fs, 'fsyncSync');

    putAttachmentText(dataDir, PROJECT, 'durável');

    expect(fsync).toHaveBeenCalledTimes(2);
  });
});

describe('S1: get paginado', () => {
  test('páginas não partem par surrogate e a concatenação é idêntica ao original', () => {
    const text = '😀'.repeat(50) + 'a' + '🚀'.repeat(50);
    const { hash } = putAttachmentText(dataDir, PROJECT, text);

    for (const limit of [1, 2, 3, 7]) {
      let offset = 0;
      let joined = '';
      for (;;) {
        const page = readAttachmentPage(dataDir, PROJECT, hash, offset, limit);
        expect(Buffer.from(page.text, 'utf8').toString('utf8')).toBe(page.text);
        joined += page.text;
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      expect(joined).toBe(text);
    }
  });

  test('sliceChars recua um caractere quando o corte cai depois de um high surrogate', () => {
    expect(sliceChars('😀😀', 0, 3)).toEqual({ text: '😀', nextOffset: 2 });
    expect(sliceChars('😀😀', 0, 1)).toEqual({ text: '😀', nextOffset: 2 });
    expect(sliceChars('abc', 1, 10)).toEqual({ text: 'bc', nextOffset: null });
    expect(sliceChars('abc', 9, 10)).toEqual({ text: '', nextOffset: null });
  });

  test('hash inexistente → ATTACHMENT_NOT_FOUND; blob adulterado → ATTACHMENT_CORRUPTED', () => {
    expect(
      captureError(() => readAttachmentPage(dataDir, PROJECT, 'a'.repeat(64), 0, 10)).code,
    ).toBe('ATTACHMENT_NOT_FOUND');

    const { hash } = putAttachmentText(dataDir, PROJECT, 'verdade');
    fs.writeFileSync(blobPath(hash), 'mentira!');
    expect(captureError(() => readAttachmentPage(dataDir, PROJECT, hash, 0, 10)).code).toBe(
      'ATTACHMENT_CORRUPTED',
    );
  });

  test('hash malformado → INVALID_INPUT bad_args (nunca chega ao sistema de arquivos)', () => {
    expect(invalidInputDetails(() => readAttachmentPage(dataDir, PROJECT, '../x', 0, 10))).toEqual([
      'bad_args',
    ]);
  });
});

describe('Q2: checkAttachment e memo do state', () => {
  test('checkAttachment: ok, missing e corrupted', () => {
    const { hash } = putAttachmentText(dataDir, PROJECT, 'conteúdo');
    expect(checkAttachment(dataDir, PROJECT, hash)).toBe('ok');
    expect(checkAttachment(dataDir, PROJECT, 'b'.repeat(64))).toBe('missing');
    fs.writeFileSync(blobPath(hash), 'conteúdA');
    expect(checkAttachment(dataDir, PROJECT, hash)).toBe('corrupted');
  });

  test('a 2ª chamada memoizada não relê o blob; checkAttachment relê sempre', () => {
    const { hash } = putAttachmentText(dataDir, PROJECT, 'memo');
    const reads = jest.spyOn(fs, 'openSync');

    expect(checkAttachmentMemoized(dataDir, PROJECT, hash)).toBe('ok');
    expect(reads).toHaveBeenCalledTimes(1);
    expect(checkAttachmentMemoized(dataDir, PROJECT, hash)).toBe('ok');
    expect(reads).toHaveBeenCalledTimes(1);

    checkAttachment(dataDir, PROJECT, hash);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  test('adulteração que preserva size e mtime é vista pelo ctime', async () => {
    const { hash } = putAttachmentText(dataDir, PROJECT, 'AAAA');
    fs.utimesSync(blobPath(hash), FIXED_TIME, FIXED_TIME);
    const before = fs.statSync(blobPath(hash));
    expect(checkAttachmentMemoized(dataDir, PROJECT, hash)).toBe('ok');

    // a granularidade do ctime no kernel é de alguns ms
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.writeFileSync(blobPath(hash), 'BBBB');
    fs.utimesSync(blobPath(hash), FIXED_TIME, FIXED_TIME);

    const after = fs.statSync(blobPath(hash));
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(checkAttachmentMemoized(dataDir, PROJECT, hash)).toBe('corrupted');
  });

  test('troca do arquivo por outro inode com mesmo size e mtime é vista', async () => {
    const { hash } = putAttachmentText(dataDir, PROJECT, 'AAAA');
    fs.utimesSync(blobPath(hash), FIXED_TIME, FIXED_TIME);
    const before = fs.statSync(blobPath(hash));
    expect(checkAttachmentMemoized(dataDir, PROJECT, hash)).toBe('ok');

    await new Promise((resolve) => setTimeout(resolve, 30));
    const substitute = path.join(dataDir, PROJECT, 'attachments', '.substituto');
    fs.writeFileSync(substitute, 'BBBB');
    fs.utimesSync(substitute, FIXED_TIME, FIXED_TIME);
    fs.renameSync(substitute, blobPath(hash));

    expect(fs.statSync(blobPath(hash)).ino).not.toBe(before.ino);
    expect(checkAttachmentMemoized(dataDir, PROJECT, hash)).toBe('corrupted');
  });

  test('blob removido → missing', () => {
    const { hash } = putAttachmentText(dataDir, PROJECT, 'some');
    expect(checkAttachmentMemoized(dataDir, PROJECT, hash)).toBe('ok');
    fs.rmSync(blobPath(hash));
    expect(checkAttachmentMemoized(dataDir, PROJECT, hash)).toBe('missing');
  });
});
