import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
// Import padrão (não `* as fs`): o spy de `openSync`/`fstatSync`/`readSync` só intercepta o mesmo
// objeto que `attachment-store.ts` usa (P9).
import fs from 'node:fs';
import * as path from 'node:path';
import {
  ATTACHMENT_MAX_BYTES,
  createAttachmentStore,
} from '../../src/adapters/fs/attachment-store.ts';
import {
  attachmentsDir as attachmentsDirOf,
  blobFile,
  dataRoot,
} from '../../src/adapters/fs/data-format.ts';
import { sha256hex } from '../../src/domain/chain.ts';
import type { AttachmentPut, AttachmentStore } from '../../src/ports.ts';
import type { AttachmentProbeArgs } from '../fixtures/fixture-args.ts';
import { captureError, createTempDir, expectNoLeak } from '../helpers.ts';
import { countFsyncs } from './fsync-spy.ts';

const PROBE = path.join(__dirname, '..', 'fixtures', 'attachment-probe.ts');
const PROJECT = 'alpha';
const PLAN = '.omc/plans/x.md';
// mtime inteiro em segundos: `utimes` com sub-milissegundo perderia precisão e o teste não reproduziria o mtime.
const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z');

let base: string;
let dataDir: string;
let cwd: string;
let outside: string;
let store: AttachmentStore;

beforeEach(() => {
  base = createTempDir('attachment-store');
  dataDir = path.join(base, 'data');
  cwd = path.join(base, 'cwd');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(cwd, '.omc', 'plans'), { recursive: true });
  fs.mkdirSync(outside);
  store = createAttachmentStore({ dataDir, cwd });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function attachmentsDir(root = dataDir): string {
  return attachmentsDirOf(root, PROJECT);
}

function blobPath(hash: string, root = dataDir): string {
  return blobFile(root, PROJECT, hash);
}

function writeInCwd(relative: string, content: string | Buffer): string {
  const file = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Erro de I/O como o do fs: `code` de errno e uma mensagem com o caminho absoluto. */
function fsError(code: string, file: string): Error {
  return Object.assign(new Error(`${code}: boom, open '${file}'`), { code });
}

/**
 * Roda `args.call` do `AttachmentStore` num filho: um `open` que travasse num FIFO estoura o
 * `timeout` (o filho é morto e o `execFileSync` lança) em vez de congelar a thread do jest.
 */
function probe(call: { call: 'status'; hash: string } | { call: 'putPath'; path: string }) {
  const args: AttachmentProbeArgs = { dataDir, cwd, project: PROJECT, ...call };
  const stdout = execFileSync(process.execPath, [PROBE, JSON.stringify(args)], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return JSON.parse(stdout) as { result?: string; error?: { code: string; details: unknown[] } };
}

/** O `fstat` passa a declarar `size` bytes, como um arquivo que cresceu depois dele. */
function understateSize(size: number): void {
  const realFstat = fs.fstatSync.bind(fs);
  jest.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) =>
    Object.assign(Object.create(realFstat(fd) as object) as object, {
      size,
    })) as unknown as typeof fs.fstatSync);
}

/**
 * Repõe `FIXED_TIME` até o ctime sair de `previousCtimeMs`: o ctime só avança quando o relógio do
 * kernel (granularidade de alguns ms) avançou, então um único `utimes` pode deixá-lo igual. Teto de 2 s.
 */
function restoreTimesUntilCtimeChanges(file: string, previousCtimeMs: number): void {
  const deadline = Date.now() + 2_000;
  do {
    fs.utimesSync(file, FIXED_TIME, FIXED_TIME);
  } while (fs.statSync(file).ctimeMs === previousCtimeMs && Date.now() < deadline);
}

/** O `INVALID_INPUT` esperado: um único `detail` em `pointer`, de `code` kebab-case. */
function invalid(pointer: string, code: string) {
  return {
    code: 'INVALID_INPUT',
    details: [{ path: pointer, code, message: expect.any(String) }],
  };
}

/** A recusa não gravou nada: a pasta de anexos do projeto nem chegou a ser criada. */
function expectNothingStored(): void {
  expect(fs.existsSync(attachmentsDir())).toBe(false);
}

const SAMPLES: [string, string][] = [
  ['pt-BR', 'Decisão: não há ação — coração\n'],
  ['emoji', 'ok 😀 e 🚀 fim'],
  ['CRLF', 'linha 1\r\nlinha 2\r\n'],
  ['BOM', '\uFEFFcom BOM'],
  ['NUL', 'antes\u0000depois'],
];

describe('put por texto', () => {
  test.each(SAMPLES)('%s: bytes e hash exatos, ida e volta idêntica', (_name, text) => {
    const result = store.putText(PROJECT, text);

    expect(result).toEqual({
      hash: sha256hex(Buffer.from(text, 'utf8')),
      bytes: Buffer.byteLength(text),
      deduplicated: false,
    });
    expect(fs.readFileSync(blobPath(result.hash))).toEqual(Buffer.from(text, 'utf8'));
    expect(store.read(PROJECT, result.hash)).toBe(text);
  });

  test('blob com modo 0o600 e pasta com 0o700, sem temporário sobrando', () => {
    const { hash } = store.putText(PROJECT, 'modo');

    expect(fs.statSync(blobPath(hash)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(attachmentsDir()).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(attachmentsDir())).toEqual([hash]);
  });

  test('o mesmo texto de novo dá o mesmo hash e não toca o blob (dedupe)', () => {
    const first = store.putText(PROJECT, 'igual');
    fs.utimesSync(blobPath(first.hash), FIXED_TIME, FIXED_TIME);
    const before = fs.statSync(blobPath(first.hash));

    const second = store.putText(PROJECT, 'igual');
    const after = fs.statSync(blobPath(first.hash));

    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ ...first, deduplicated: true });
    expect(fs.readdirSync(attachmentsDir())).toEqual([first.hash]);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  test('o mesmo texto sobre blob adulterado → ATTACHMENT_CORRUPTED, sem sobrescrever', () => {
    const { hash } = store.putText(PROJECT, 'original');
    fs.writeFileSync(blobPath(hash), 'adulterado');

    expect(captureError(() => store.putText(PROJECT, 'original')).code).toBe(
      'ATTACHMENT_CORRUPTED',
    );
    expect(fs.readFileSync(blobPath(hash), 'utf8')).toBe('adulterado');
    expect(fs.readdirSync(attachmentsDir())).toEqual([hash]);
  });

  test('o teto é 1 MiB em bytes, não em caracteres', () => {
    const atCeiling = 'a'.repeat(ATTACHMENT_MAX_BYTES);
    expect(store.putText(PROJECT, atCeiling).bytes).toBe(ATTACHMENT_MAX_BYTES);
    // 2 bytes por caractere: metade do teto em caracteres cabe, exatamente, em bytes
    expect(store.putText(PROJECT, 'ã'.repeat(ATTACHMENT_MAX_BYTES / 2)).bytes).toBe(
      ATTACHMENT_MAX_BYTES,
    );

    expect(captureError(() => store.putText(PROJECT, `${atCeiling}a`))).toMatchObject(
      invalid('/text', 'too-big'),
    );
    // metade do teto em caracteres, mas acima dele em bytes
    expect(
      captureError(() => store.putText(PROJECT, 'ã'.repeat(ATTACHMENT_MAX_BYTES / 2 + 1))),
    ).toMatchObject(invalid('/text', 'too-big'));
  });

  test('nome de projeto e hash inválidos nunca chegam ao disco', () => {
    expect(captureError(() => store.putText('../fora', 'x'))).toMatchObject(
      invalid('/project', 'invalid-name'),
    );
    expect(captureError(() => store.status(PROJECT, '../x'))).toMatchObject(
      invalid('/hash', 'invalid-hash'),
    );
    expect(captureError(() => store.read(PROJECT, 'A'.repeat(64)))).toMatchObject(
      invalid('/hash', 'invalid-hash'),
    );
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  test('faz fsync do arquivo e do diretório depois do link; o put deduplicado não dá nenhum', () => {
    const fsyncs = countFsyncs();

    store.putText(PROJECT, 'durável');
    expect(fsyncs()).toEqual({ files: 1, directories: 1 });

    // o `lstat` acha o blob antes de criar o temporário, então não há o que sincronizar
    expect(store.putText(PROJECT, 'durável').deduplicated).toBe(true);
    expect(fsyncs()).toEqual({ files: 1, directories: 1 });
  });

  test('o put deduplicado só abre o blob, para reler: não cria temporário', () => {
    const { hash } = store.putText(PROJECT, 'repetido');
    const opens = jest.spyOn(fs, 'openSync');

    expect(store.putText(PROJECT, 'repetido').deduplicated).toBe(true);

    expect(opens).toHaveBeenCalledTimes(1);
    expect(opens).toHaveBeenCalledWith(blobPath(hash), expect.anything());
    expect(fs.readdirSync(attachmentsDir())).toEqual([hash]);
  });

  test.each(['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync'] as const)(
    'erro de %s na gravação vira IO_ERROR só com o errno, sem o caminho absoluto',
    (method) => {
      (jest.spyOn(fs, method) as jest.Mock).mockImplementation(() => {
        throw fsError('EIO', attachmentsDir());
      });

      const error = captureError(() => store.putText(PROJECT, 'io'));

      expect(error.code).toBe('IO_ERROR');
      expect(error.details).toEqual([{ path: '', code: 'eio', message: 'I/O failure' }]);
      expectNoLeak(error, base);
    },
  );

  test('corrida: o concorrente grava o mesmo texto entre o temporário e o link, e só um put é novo', () => {
    const rival = createAttachmentStore({ dataDir, cwd });
    const realLink = fs.linkSync.bind(fs);
    let rivalResult: AttachmentPut | undefined;
    jest.spyOn(fs, 'linkSync').mockImplementationOnce((existing, target) => {
      rivalResult = rival.putText(PROJECT, 'corrida');
      realLink(existing, target);
    });

    const result = store.putText(PROJECT, 'corrida');

    expect(rivalResult?.deduplicated).toBe(false);
    expect(result).toEqual({ ...rivalResult, deduplicated: true });
    expect(fs.readdirSync(attachmentsDir())).toEqual([result.hash]);
    expect(store.read(PROJECT, result.hash)).toBe('corrida');
  });

  test('corrida: o link dá EEXIST mas o blob sumiu antes da releitura → ATTACHMENT_CORRUPTED', () => {
    jest.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw fsError('EEXIST', attachmentsDir());
    });

    expect(captureError(() => store.putText(PROJECT, 'sumiu')).code).toBe('ATTACHMENT_CORRUPTED');
    // nada publicado e o temporário foi removido
    expect(fs.readdirSync(attachmentsDir())).toEqual([]);
  });
});

describe('status e read', () => {
  test('status: ok, missing e corrupted; read: texto, ATTACHMENT_NOT_FOUND e ATTACHMENT_CORRUPTED', () => {
    const { hash } = store.putText(PROJECT, 'conteúdo');
    const absent = 'b'.repeat(64);

    expect(store.status(PROJECT, hash)).toBe('ok');
    expect(store.status(PROJECT, absent)).toBe('missing');
    expect(captureError(() => store.read(PROJECT, absent))).toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
      details: [{ path: '/hash', code: 'not-found', message: expect.any(String) }],
    });

    fs.writeFileSync(blobPath(hash), 'conteúdA');
    expect(store.status(PROJECT, hash)).toBe('corrupted');
    expect(captureError(() => store.read(PROJECT, hash))).toMatchObject({
      code: 'ATTACHMENT_CORRUPTED',
      details: [{ path: '/hash', code: 'corrupted', message: expect.any(String) }],
    });
  });

  test('bytes íntegros que não são UTF-8 → read dá ATTACHMENT_CORRUPTED', () => {
    const bytes = Buffer.from([0x61, 0xff, 0xfe]);
    const hash = sha256hex(bytes);
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    fs.writeFileSync(blobPath(hash), bytes);

    expect(captureError(() => store.read(PROJECT, hash)).code).toBe('ATTACHMENT_CORRUPTED');
  });

  test('symlink com o conteúdo certo → corrupted, no status e no read', () => {
    const hash = sha256hex('conteudo');
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    fs.writeFileSync(path.join(outside, 'alvo'), 'conteudo');
    fs.symlinkSync(path.join(outside, 'alvo'), blobPath(hash));

    expect(store.status(PROJECT, hash)).toBe('corrupted');
    expect(captureError(() => store.read(PROJECT, hash)).code).toBe('ATTACHMENT_CORRUPTED');
  });

  test('FIFO, diretório e arquivo acima de 1 MiB no lugar do blob → corrupted, sem travar', () => {
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    const fifo = sha256hex('fifo');
    const directory = sha256hex('diretório');
    const big = sha256hex('grande');
    execFileSync('mkfifo', [blobPath(fifo)]);
    fs.mkdirSync(blobPath(directory));
    fs.writeFileSync(blobPath(big), Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));

    expect(probe({ call: 'status', hash: fifo })).toEqual({ result: 'corrupted' });
    expect([directory, big].map((hash) => store.status(PROJECT, hash))).toEqual([
      'corrupted',
      'corrupted',
    ]);
  });

  test('blob que cresce entre o fstat e a leitura → corrupted, mesmo com o sha256 dos bytes certo', () => {
    // blob legítimo de 11 bytes; o `fstat` diz 10: a releitura vê 11 e recusa, embora o hash bata
    const bytes = Buffer.alloc(11, 0x61);
    const hash = sha256hex(bytes);
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    fs.writeFileSync(blobPath(hash), bytes);
    understateSize(10);

    expect(store.status(PROJECT, hash)).toBe('corrupted');
    expect(captureError(() => store.read(PROJECT, hash)).code).toBe('ATTACHMENT_CORRUPTED');
  });

  test('erro de leitura do blob vira IO_ERROR só com o errno, sem o caminho absoluto', () => {
    const { hash } = store.putText(PROJECT, 'io');
    jest.spyOn(fs, 'readSync').mockImplementation(() => {
      throw fsError('EIO', blobPath(hash));
    });

    const error = captureError(() => store.read(PROJECT, hash));

    expect(error.code).toBe('IO_ERROR');
    expect(error.details).toEqual([{ path: '', code: 'eio', message: 'I/O failure' }]);
    expectNoLeak(error, base);
  });
});

describe('memo de verificação do status', () => {
  test('a 2ª chamada não relê o blob; read relê sempre', () => {
    const { hash } = store.putText(PROJECT, 'memo');
    const opens = jest.spyOn(fs, 'openSync');

    expect(store.status(PROJECT, hash)).toBe('ok');
    expect(opens).toHaveBeenCalledTimes(1);
    expect(store.status(PROJECT, hash)).toBe('ok');
    expect(opens).toHaveBeenCalledTimes(1);

    store.read(PROJECT, hash);
    expect(opens).toHaveBeenCalledTimes(2);
  });

  test('adulteração que preserva size e mtime é vista pelo ctime', () => {
    const { hash } = store.putText(PROJECT, 'AAAA');
    fs.utimesSync(blobPath(hash), FIXED_TIME, FIXED_TIME);
    const before = fs.statSync(blobPath(hash));
    expect(store.status(PROJECT, hash)).toBe('ok');

    fs.writeFileSync(blobPath(hash), 'BBBB');
    restoreTimesUntilCtimeChanges(blobPath(hash), before.ctimeMs);

    const after = fs.statSync(blobPath(hash));
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    expect(store.status(PROJECT, hash)).toBe('corrupted');
  });

  test('blob removido → missing', () => {
    const { hash } = store.putText(PROJECT, 'some');
    expect(store.status(PROJECT, hash)).toBe('ok');

    fs.rmSync(blobPath(hash));

    expect(store.status(PROJECT, hash)).toBe('missing');
  });
});

describe('put por path (P16, D-15)', () => {
  test('guarda os bytes exatos de um arquivo em pasta de ponto, por caminho relativo e absoluto', () => {
    const text = 'Decisão longa — ação\r\n\uFEFF'.repeat(11_000);
    const file = writeInCwd(PLAN, text);

    const relative = store.putPath(PROJECT, PLAN);
    const absolute = store.putPath(PROJECT, file);

    expect(relative.bytes).toBe(Buffer.byteLength(text));
    expect(absolute).toEqual({ ...relative, deduplicated: true });
    expect(fs.readFileSync(blobPath(relative.hash))).toEqual(Buffer.from(text, 'utf8'));
    expect(relative.hash).toBe(sha256hex(Buffer.from(text, 'utf8')));
  });

  test('lê de qualquer subpasta do cwd, não só de .omc/plans, e do próprio cwd', () => {
    writeInCwd('docs/fundo/notas.txt', 'subpasta');
    writeInCwd('raiz.md', 'raiz');

    expect(store.putPath(PROJECT, 'docs/fundo/notas.txt').hash).toBe(sha256hex('subpasta'));
    expect(store.putPath(PROJECT, 'raiz.md').hash).toBe(sha256hex('raiz'));
  });

  test('o arquivo de 1 MiB exato entra', () => {
    writeInCwd(PLAN, Buffer.alloc(ATTACHMENT_MAX_BYTES, 0x61));

    expect(store.putPath(PROJECT, PLAN).bytes).toBe(ATTACHMENT_MAX_BYTES);
  });

  test('o mesmo conteúdo por path e por texto cai no mesmo blob (dedupe)', () => {
    writeInCwd(PLAN, 'mesmo conteúdo');

    const byPath = store.putPath(PROJECT, PLAN);
    const byText = store.putText(PROJECT, 'mesmo conteúdo');

    expect(byText).toEqual({ ...byPath, deduplicated: true });
    expect(fs.readdirSync(attachmentsDir())).toEqual([byPath.hash]);
  });

  test('../ e caminho absoluto fora do cwd → outside-allowed-root, sem gravar', () => {
    fs.writeFileSync(path.join(outside, 'x.md'), 'fora');

    expect(captureError(() => store.putPath(PROJECT, '../outside/x.md'))).toMatchObject(
      invalid('/path', 'outside-allowed-root'),
    );
    expect(captureError(() => store.putPath(PROJECT, path.join(outside, 'x.md')))).toMatchObject(
      invalid('/path', 'outside-allowed-root'),
    );
    expectNothingStored();
  });

  test('symlink de diretório para fora do cwd → outside-allowed-root, sem gravar', () => {
    fs.writeFileSync(path.join(outside, 'x.md'), 'fora');
    fs.symlinkSync(outside, path.join(cwd, 'atalho'));

    expect(captureError(() => store.putPath(PROJECT, 'atalho/x.md'))).toMatchObject(
      invalid('/path', 'outside-allowed-root'),
    );
    expectNothingStored();
  });

  test('cwd e diretório inexistentes → outside-allowed-root, sem vazar errno nem caminho', () => {
    const gone = path.join(base, 'nao-existe');
    const missingDirectory = captureError(() => store.putPath(PROJECT, 'nao/existe/x.md'));
    const missingCwd = captureError(() =>
      createAttachmentStore({ dataDir, cwd: gone }).putPath(PROJECT, PLAN),
    );

    for (const error of [missingDirectory, missingCwd]) {
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details.map((detail) => detail.code)).toEqual(['outside-allowed-root']);
      expectNoLeak(error, base);
      expectNoLeak(error, 'ENOENT');
    }
  });

  test('cwd que é symlink: a raiz é o destino resolvido, dentro lê e fora segue recusado', () => {
    const linkedCwd = path.join(base, 'cwd-link');
    fs.symlinkSync(cwd, linkedCwd);
    writeInCwd(PLAN, 'via symlink');
    fs.writeFileSync(path.join(outside, 'x.md'), 'fora');
    const linked = createAttachmentStore({ dataDir, cwd: linkedCwd });

    expect(linked.putPath(PROJECT, PLAN).hash).toBe(sha256hex('via symlink'));
    expect(captureError(() => linked.putPath(PROJECT, path.join(outside, 'x.md')))).toMatchObject(
      invalid('/path', 'outside-allowed-root'),
    );
  });

  test('dataDir que é symlink para dentro do cwd: arquivo no destino → inside-data-dir', () => {
    const real = path.join(cwd, 'dados');
    const linkedDataDir = path.join(base, 'dados-link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, linkedDataDir);
    fs.writeFileSync(path.join(real, 'x.md'), 'dentro');
    const linked = createAttachmentStore({ dataDir: linkedDataDir, cwd });

    expect(captureError(() => linked.putPath(PROJECT, 'dados/x.md'))).toMatchObject(
      invalid('/path', 'inside-data-dir'),
    );
    expect(fs.existsSync(attachmentsDir(real))).toBe(false);
  });

  describe('com o dataDir dentro do cwd', () => {
    beforeEach(() => {
      dataDir = path.join(cwd, 'dados');
      store = createAttachmentStore({ dataDir, cwd });
    });

    test('arquivo dentro do dataDir → inside-data-dir, sem gravar', () => {
      const inside = path.join(dataRoot(dataDir), PROJECT, 'x.md');
      fs.mkdirSync(path.dirname(inside), { recursive: true });
      fs.writeFileSync(inside, 'dentro');

      expect(captureError(() => store.putPath(PROJECT, inside))).toMatchObject(
        invalid('/path', 'inside-data-dir'),
      );
      expect(fs.existsSync(attachmentsDir())).toBe(false);
    });

    test('symlink de diretório que aponta para dentro do dataDir → inside-data-dir (depois do realpath)', () => {
      const inside = path.join(dataRoot(dataDir), PROJECT);
      fs.mkdirSync(inside, { recursive: true });
      fs.writeFileSync(path.join(inside, 'x.md'), 'dentro');
      fs.symlinkSync(inside, path.join(cwd, 'atalho'));

      expect(captureError(() => store.putPath(PROJECT, 'atalho/x.md'))).toMatchObject(
        invalid('/path', 'inside-data-dir'),
      );
      expect(fs.existsSync(attachmentsDir())).toBe(false);
    });

    test('inside-data-dir vem antes de not-found; arquivo fora do dataDir segue normalmente', () => {
      fs.mkdirSync(dataDir);
      writeInCwd(PLAN, 'fora do dataDir');

      expect(captureError(() => store.putPath(PROJECT, 'dados/nao-existe.md'))).toMatchObject(
        invalid('/path', 'inside-data-dir'),
      );
      expect(store.putPath(PROJECT, PLAN).hash).toBe(sha256hex('fora do dataDir'));
    });
  });

  test('dataDir inexistente não tem o que recusar', () => {
    writeInCwd(PLAN, 'sem dataDir');
    expect(fs.existsSync(dataDir)).toBe(false);

    expect(store.putPath(PROJECT, PLAN).hash).toBe(sha256hex('sem dataDir'));
  });

  test('outside-allowed-root vem antes de not-found', () => {
    expect(
      captureError(() => store.putPath(PROJECT, path.join(outside, 'nao-existe.md'))),
    ).toMatchObject(invalid('/path', 'outside-allowed-root'));
  });

  test('arquivo inexistente → not-found, sem errno nem caminho', () => {
    const error = captureError(() => store.putPath(PROJECT, '.omc/plans/nao-existe.md'));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.map((detail) => detail.code)).toEqual(['not-found']);
    expectNoLeak(error, base);
    expectNoLeak(error, 'ENOENT');
    expectNothingStored();
  });

  // No filho (`probe`): o FIFO travaria a thread do jest se o `open` perdesse o `O_NONBLOCK`.
  test.each([
    [
      'symlink no componente final, mesmo apontando para dentro do cwd',
      () => {
        writeInCwd('alvo.md', 'alvo');
        fs.symlinkSync(path.join(cwd, 'alvo.md'), path.join(cwd, '.omc', 'plans', 'link.md'));
        return '.omc/plans/link.md';
      },
    ],
    [
      'diretório chamado *.md',
      () => {
        fs.mkdirSync(path.join(cwd, 'pasta.md'));
        return 'pasta.md';
      },
    ],
    [
      'FIFO chamado *.md',
      () => {
        execFileSync('mkfifo', [path.join(cwd, 'fila.md')]);
        return 'fila.md';
      },
    ],
    [
      'hardlink (nlink > 1)',
      () => {
        writeInCwd('segredo.md', 'segredo');
        fs.linkSync(path.join(cwd, 'segredo.md'), path.join(cwd, '.omc', 'plans', 'link.md'));
        return '.omc/plans/link.md';
      },
    ],
  ])('%s → not-regular, sem gravar', (_name, prepare) => {
    const candidate = prepare();

    expect(probe({ call: 'putPath', path: candidate })).toEqual({
      error: invalid('/path', 'not-regular'),
    });
    expectNothingStored();
  });

  test('arquivo acima de 1 MiB → too-big, sem gravar', () => {
    writeInCwd(PLAN, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));

    expect(captureError(() => store.putPath(PROJECT, PLAN))).toMatchObject(
      invalid('/path', 'too-big'),
    );
    expectNothingStored();
  });

  test('arquivo que cresce entre o fstat e a leitura → too-big', () => {
    writeInCwd(PLAN, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));
    understateSize(10);

    const error = captureError(() => store.putPath(PROJECT, PLAN));

    expect(error).toMatchObject(invalid('/path', 'too-big'));
    expect(error.message).toBe('file changed while being read');
  });

  test('arquivo vazio → bad-args; bytes que não são UTF-8 → invalid-utf8', () => {
    writeInCwd('vazio.md', '');
    writeInCwd('binario.md', Buffer.from([0x61, 0xff, 0xfe]));

    expect(captureError(() => store.putPath(PROJECT, 'vazio.md'))).toMatchObject(
      invalid('/path', 'bad-args'),
    );
    expect(captureError(() => store.putPath(PROJECT, 'binario.md'))).toMatchObject(
      invalid('/path', 'invalid-utf8'),
    );
    expectNothingStored();
  });

  test('erro de leitura do arquivo vira IO_ERROR só com o errno, sem o caminho absoluto', () => {
    const file = writeInCwd(PLAN, 'conteúdo');
    jest.spyOn(fs, 'readSync').mockImplementation(() => {
      throw fsError('EIO', file);
    });

    const error = captureError(() => store.putPath(PROJECT, PLAN));

    expect(error.code).toBe('IO_ERROR');
    expect(error.details).toEqual([{ path: '', code: 'eio', message: 'I/O failure' }]);
    expectNoLeak(error, base);
  });

  describe('diretório trocado por symlink entre o realpath e o open', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(outside, 'x.md'), 'fora');
      writeInCwd(PLAN, 'dentro');
    });

    /** Na 1ª chamada de `openSync` (a do arquivo) troca `.omc/plans` por um symlink para `outside`. */
    function swapDirectoryOnOpen(): void {
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

    function withoutProc(): void {
      const realRealpath = fs.realpathSync.bind(fs);
      jest.spyOn(fs, 'realpathSync').mockImplementation((target: fs.PathLike) => {
        if (String(target).startsWith('/proc/self/fd/')) throw fsError('ENOENT', String(target));
        return realRealpath(target);
      });
    }

    test('com /proc: outside-allowed-root, sem gravar', () => {
      swapDirectoryOnOpen();

      expect(captureError(() => store.putPath(PROJECT, PLAN))).toMatchObject(
        invalid('/path', 'outside-allowed-root'),
      );
      expectNothingStored();
    });

    test('sem /proc (macOS): a troca também é recusada', () => {
      withoutProc();
      swapDirectoryOnOpen();

      expect(captureError(() => store.putPath(PROJECT, PLAN))).toMatchObject(
        invalid('/path', 'outside-allowed-root'),
      );
      expectNothingStored();
    });

    test('sem /proc e sem troca, o put segue normalmente', () => {
      withoutProc();

      expect(store.putPath(PROJECT, PLAN).hash).toBe(sha256hex('dentro'));
    });
  });
});
