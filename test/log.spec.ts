import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
// import default (não `* as fs`): precisa ser o mesmo objeto que src/log.ts usa, para
// jest.spyOn interceptar de fato a chamada feita lá dentro (ver comentário em src/log.ts).
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { anchor, hashLine, verifyChain } from '../src/chain.ts';
import type { EventLine } from '../src/events.ts';
import { append, readText, type LogRecord } from '../src/log.ts';

const MANIFESTO = { projeto: 'p', processo: 'proc', fixado: { versao: 1 } };

type Base = {
  seq: number;
  timestamp: string;
  prevHash: string;
  uuid: string;
  lastLink: EventLine | null;
};

function montarLinha(base: Base): EventLine {
  return {
    seq: base.seq,
    id: `p:proc:milestone:${base.uuid}`,
    type: 'milestone',
    timestamp: base.timestamp,
    agent: 'agente-teste',
    prevHash: base.prevHash,
    data: { milestoneType: 'passo', target: 'hex:target:u1' },
  };
}

function criarLoggerEspiao(): { log: (registro: LogRecord) => void; registros: LogRecord[] } {
  const registros: LogRecord[] = [];
  return { log: (registro: LogRecord) => registros.push(registro), registros };
}

let dirTemp: string;
let arquivo: string;

beforeEach(() => {
  dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-log-'));
  arquivo = path.join(dirTemp, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(dirTemp, { recursive: true, force: true });
});

describe('anexar — encadeamento', () => {
  test('1º elo usa a âncora do manifesto como prevHash e seq 0', async () => {
    const { log } = criarLoggerEspiao();

    const linha = await append(arquivo, MANIFESTO, montarLinha, { log });

    expect(linha.seq).toBe(0);
    expect(linha.prevHash).toBe(anchor(MANIFESTO));
  });

  test('2º elo encadeia no anterior', async () => {
    const { log } = criarLoggerEspiao();
    const primeiro = await append(arquivo, MANIFESTO, montarLinha, { log });

    const segundo = await append(arquivo, MANIFESTO, montarLinha, { log });

    expect(segundo.seq).toBe(1);
    expect(segundo.prevHash).toBe(hashLine(primeiro));
  });

  test('fsyncSync é chamado a cada append', async () => {
    const espiaoFsync = jest.spyOn(fs, 'fsyncSync');
    const { log } = criarLoggerEspiao();

    await append(arquivo, MANIFESTO, montarLinha, { log });

    expect(espiaoFsync).toHaveBeenCalledTimes(1);
    espiaoFsync.mockRestore();
  });

  test('2 chamadas em sequência no mesmo processo produzem 2 elos íntegros', async () => {
    const { log } = criarLoggerEspiao();

    await append(arquivo, MANIFESTO, montarLinha, { log });
    await append(arquivo, MANIFESTO, montarLinha, { log });

    const resultado = verifyChain(readText(arquivo), MANIFESTO);
    expect(resultado.ok).toBe(true);
    expect(resultado.totalLines).toBe(2);
  });
});

describe('anexar — rasgo (cauda sem \\n final)', () => {
  test('JSON completo sem \\n final vira elo válido e o próximo encadeia nele', async () => {
    const { log } = criarLoggerEspiao();
    const primeiro = await append(arquivo, MANIFESTO, montarLinha, { log });
    const textoSemQuebra = fs.readFileSync(arquivo, 'utf8').replace(/\n$/, ''); // simula escrita interrompida só no separador
    fs.writeFileSync(arquivo, textoSemQuebra);

    const segundo = await append(arquivo, MANIFESTO, montarLinha, { log });

    expect(segundo.seq).toBe(1);
    expect(segundo.prevHash).toBe(hashLine(primeiro));
    expect(fs.readFileSync(arquivo, 'utf8')).toBe(
      `${textoSemQuebra}\n${JSON.stringify(segundo)}\n`,
    );
  });

  test('cauda truncada (JSON incompleto) sem \\n: o próximo append insere \\n e conta a rasgada no seq', async () => {
    const { log } = criarLoggerEspiao();
    const primeiro = await append(arquivo, MANIFESTO, montarLinha, { log });
    fs.appendFileSync(arquivo, '{"seq":1,"id":"p:proc:marco:incompl'); // rasgo: JSON truncado, sem \n

    const segundo = await append(arquivo, MANIFESTO, montarLinha, { log });

    expect(segundo.seq).toBe(2); // conta a linha rasgada como pendente
    expect(segundo.prevHash).toBe(hashLine(primeiro)); // aponta pro último elo válido, não pro rasgo
    expect(fs.readFileSync(arquivo, 'utf8').endsWith(`\n${JSON.stringify(segundo)}\n`)).toBe(true);
  });
});

describe('anexar — lock', () => {
  test('LOCK_TIMEOUT com lock alheio: nenhuma linha escrita e o lock alheio não é removido', async () => {
    const dirLock = `${arquivo}.lock`;
    fs.mkdirSync(dirLock, 0o700); // mtime fresco: nunca órfão neste teste
    const { log, registros } = criarLoggerEspiao();

    await expect(
      append(arquivo, MANIFESTO, montarLinha, { log, timeoutMs: 200, orphanMs: 60_000 }),
    ).rejects.toEqual(expect.objectContaining({ code: 'LOCK_TIMEOUT' }));

    expect(readText(arquivo)).toBe('');
    expect(fs.existsSync(dirLock)).toBe(true);
    expect(registros.filter((r) => r.event === 'lock-wait')).toHaveLength(1);
  });

  test('lock órfão (mtime velho) é removido, loga lock-orfao-removido, e o append segue', async () => {
    const dirLock = `${arquivo}.lock`;
    fs.mkdirSync(dirLock, 0o700);
    const antigo = new Date(Date.now() - 20_000);
    fs.utimesSync(dirLock, antigo, antigo); // mais velho que o orfaoMs abaixo
    const { log, registros } = criarLoggerEspiao();

    const linha = await append(arquivo, MANIFESTO, montarLinha, {
      log,
      orphanMs: 5_000,
      timeoutMs: 2_000,
    });

    expect(linha.seq).toBe(0);
    expect(registros.some((r) => r.event === 'lock-orphan-removed')).toBe(true);
    expect(fs.existsSync(dirLock)).toBe(false); // liberado ao final do append (lock era do próprio processo)
  });

  test('lock-espera é emitido exatamente 1× por requisição mesmo com várias colisões', async () => {
    const dirLock = `${arquivo}.lock`;
    fs.mkdirSync(dirLock, 0o700);
    const { log, registros } = criarLoggerEspiao();

    // timeoutMs pequeno com retry de 10ms gera várias colisões antes de estourar
    await expect(
      append(arquivo, MANIFESTO, montarLinha, { log, timeoutMs: 50, orphanMs: 60_000 }),
    ).rejects.toThrow();

    expect(registros.filter((r) => r.event === 'lock-wait')).toHaveLength(1);
  });
});

describe('anexar — fencing', () => {
  test('holder trocado durante montar → LOCK_PERDIDO, 0 linhas novas, log lock-perdido, lock alheio intacto', async () => {
    const dirLock = `${arquivo}.lock`;
    const { log, registros } = criarLoggerEspiao();

    const montarComRoubo = (base: Base): EventLine => {
      // simula um segundo dono assumindo o lock entre a montagem e a escrita
      fs.writeFileSync(path.join(dirLock, 'holder'), 'outro-token', { mode: 0o600 });
      return montarLinha(base);
    };

    await expect(append(arquivo, MANIFESTO, montarComRoubo, { log })).rejects.toEqual(
      expect.objectContaining({ code: 'LOCK_LOST' }),
    );

    expect(readText(arquivo)).toBe('');
    expect(registros.some((r) => r.event === 'lock-lost')).toBe(true);
    expect(fs.readFileSync(path.join(dirLock, 'holder'), 'utf8')).toBe('outro-token'); // release não mexeu no lock alheio
  });
});

describe('lerTexto', () => {
  test('arquivo inexistente → string vazia', () => {
    expect(readText(path.join(dirTemp, 'nao-existe.jsonl'))).toBe('');
  });
});
