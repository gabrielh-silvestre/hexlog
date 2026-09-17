import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
// import default (não `* as fs`): precisa ser o mesmo objeto que src/log.ts usa, para
// jest.spyOn interceptar de fato a chamada feita lá dentro (ver comentário em src/log.ts).
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { anchor, hashLine, verifyChain } from '../src/chain.ts';
import type { EventLine } from '../src/events.ts';
import { append, readText, type LogRecord } from '../src/log.ts';

const MANIFEST = { project: 'p', process: 'proc', fixed: { version: 1 } };

type Base = {
  seq: number;
  timestamp: string;
  prevHash: string;
  uuid: string;
  lastLink: EventLine | null;
};

function buildLine(base: Base): EventLine {
  return {
    seq: base.seq,
    id: `p:proc:milestone:${base.uuid}`,
    type: 'milestone',
    timestamp: base.timestamp,
    agent: 'test-agent',
    prevHash: base.prevHash,
    data: { milestoneType: 'step', target: 'hex:target:u1' },
  };
}

function createSpyLogger(): { log: (record: LogRecord) => void; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { log: (record: LogRecord) => records.push(record), records };
}

let tempDir: string;
let file: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-log-'));
  file = path.join(tempDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('anexar — encadeamento', () => {
  test('1º elo usa a âncora do manifesto como prevHash e seq 0', async () => {
    const { log } = createSpyLogger();

    const line = await append(file, MANIFEST, buildLine, { log });

    expect(line.seq).toBe(0);
    expect(line.prevHash).toBe(anchor(MANIFEST));
  });

  test('2º elo encadeia no anterior', async () => {
    const { log } = createSpyLogger();
    const first = await append(file, MANIFEST, buildLine, { log });

    const second = await append(file, MANIFEST, buildLine, { log });

    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(hashLine(first));
  });

  test('fsyncSync é chamado a cada append', async () => {
    const fsyncSpy = jest.spyOn(fs, 'fsyncSync');
    const { log } = createSpyLogger();

    await append(file, MANIFEST, buildLine, { log });

    expect(fsyncSpy).toHaveBeenCalledTimes(1);
    fsyncSpy.mockRestore();
  });

  test('2 chamadas em sequência no mesmo processo produzem 2 elos íntegros', async () => {
    const { log } = createSpyLogger();

    await append(file, MANIFEST, buildLine, { log });
    await append(file, MANIFEST, buildLine, { log });

    const result = verifyChain(readText(file), MANIFEST);
    expect(result.ok).toBe(true);
    expect(result.totalLines).toBe(2);
  });
});

describe('anexar — rasgo (cauda sem \\n final)', () => {
  test('JSON completo sem \\n final vira elo válido e o próximo encadeia nele', async () => {
    const { log } = createSpyLogger();
    const first = await append(file, MANIFEST, buildLine, { log });
    const textWithoutBreak = fs.readFileSync(file, 'utf8').replace(/\n$/, ''); // simula escrita interrompida só no separador
    fs.writeFileSync(file, textWithoutBreak);

    const second = await append(file, MANIFEST, buildLine, { log });

    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(hashLine(first));
    expect(fs.readFileSync(file, 'utf8')).toBe(`${textWithoutBreak}\n${JSON.stringify(second)}\n`);
  });

  test('cauda truncada (JSON incompleto) sem \\n: o próximo append insere \\n e conta a rasgada no seq', async () => {
    const { log } = createSpyLogger();
    const first = await append(file, MANIFEST, buildLine, { log });
    fs.appendFileSync(file, '{"seq":1,"id":"p:proc:milestone:incompl'); // rasgo: JSON truncado, sem \n

    const second = await append(file, MANIFEST, buildLine, { log });

    expect(second.seq).toBe(2); // conta a linha rasgada como pendente
    expect(second.prevHash).toBe(hashLine(first)); // aponta pro último elo válido, não pro rasgo
    expect(fs.readFileSync(file, 'utf8').endsWith(`\n${JSON.stringify(second)}\n`)).toBe(true);
  });
});

describe('anexar — lock', () => {
  test('LOCK_TIMEOUT com lock alheio: nenhuma linha escrita e o lock alheio não é removido', async () => {
    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir, 0o700); // mtime fresco: nunca órfão neste teste
    const { log, records } = createSpyLogger();

    await expect(
      append(file, MANIFEST, buildLine, { log, timeoutMs: 200, orphanMs: 60_000 }),
    ).rejects.toEqual(expect.objectContaining({ code: 'LOCK_TIMEOUT' }));

    expect(readText(file)).toBe('');
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(records.filter((r) => r.event === 'lock-wait')).toHaveLength(1);
  });

  test('lock órfão (mtime velho) é removido, loga lock-orfao-removido, e o append segue', async () => {
    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir, 0o700);
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(lockDir, old, old); // mais velho que o orphanMs abaixo
    const { log, records } = createSpyLogger();

    const line = await append(file, MANIFEST, buildLine, {
      log,
      orphanMs: 5_000,
      timeoutMs: 2_000,
    });

    expect(line.seq).toBe(0);
    expect(records.some((r) => r.event === 'lock-orphan-removed')).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false); // liberado ao final do append (lock era do próprio processo)
  });

  test('lock-espera é emitido exatamente 1× por requisição mesmo com várias colisões', async () => {
    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir, 0o700);
    const { log, records } = createSpyLogger();

    // timeoutMs pequeno com retry de 10ms gera várias colisões antes de estourar
    await expect(
      append(file, MANIFEST, buildLine, { log, timeoutMs: 50, orphanMs: 60_000 }),
    ).rejects.toThrow();

    expect(records.filter((r) => r.event === 'lock-wait')).toHaveLength(1);
  });
});

describe('anexar — fencing', () => {
  test('holder trocado durante montar → LOCK_PERDIDO, 0 linhas novas, log lock-perdido, lock alheio intacto', async () => {
    const lockDir = `${file}.lock`;
    const { log, records } = createSpyLogger();

    const buildWithLockTheft = (base: Base): EventLine => {
      // simula um segundo dono assumindo o lock entre a montagem e a escrita
      fs.writeFileSync(path.join(lockDir, 'holder'), 'other-token', { mode: 0o600 });
      return buildLine(base);
    };

    await expect(append(file, MANIFEST, buildWithLockTheft, { log })).rejects.toEqual(
      expect.objectContaining({ code: 'LOCK_LOST' }),
    );

    expect(readText(file)).toBe('');
    expect(records.some((r) => r.event === 'lock-lost')).toBe(true);
    expect(fs.readFileSync(path.join(lockDir, 'holder'), 'utf8')).toBe('other-token'); // release não mexeu no lock alheio
  });
});

describe('lerTexto', () => {
  test('arquivo inexistente → string vazia', () => {
    expect(readText(path.join(tempDir, 'does-not-exist.jsonl'))).toBe('');
  });
});
