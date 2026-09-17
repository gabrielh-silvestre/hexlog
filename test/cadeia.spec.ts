import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import fc from 'fast-check';
import type { Linha } from '../src/eventos.ts';
import {
  ancora,
  hashLinha,
  prevHashEsperado,
  proximoSeq,
  sha256hex,
  verificarCadeia,
} from '../src/cadeia.ts';

const MANIFESTO = { projeto: 'p', processo: 'proc', fixado: { versao: 1 } };

function construirLinha(indice: number, ultimoElo: Linha | null, marcoTipo = 'passo'): Linha {
  return {
    seq: proximoSeq(ultimoElo, 0),
    id: `p:proc:marco:${randomUUIDv7()}`,
    tipo: 'marco',
    timestamp: new Date(Date.UTC(2026, 0, 1 + indice)).toISOString(),
    agente: 'agente-teste',
    prevHash: prevHashEsperado(ultimoElo, MANIFESTO),
    dados: { marcoTipo, alvo: 'hex:alvo:u1' },
  };
}

/** Log íntegro de `quantidade` elos encadeados a partir do manifesto (linhas 0..quantidade-1). */
function construirLog(quantidade: number): Linha[] {
  const linhas: Linha[] = [];
  let ultimoElo: Linha | null = null;
  for (let indice = 0; indice < quantidade; indice++) {
    const elo = construirLinha(indice, ultimoElo);
    linhas.push(elo);
    ultimoElo = elo;
  }
  return linhas;
}

function paraTexto(linhas: Array<Linha | string>): string {
  return linhas.map((linha) => (typeof linha === 'string' ? linha : JSON.stringify(linha))).join('\n') + '\n';
}

describe('hashLinha / ancora (N10, golden)', () => {
  const manifesto = { projeto: 'p', processo: 'x', fixado: { versao: 1 } };
  const anc = '086da7f0012515baec7fc75f3d0031be58c332c472c40a447bd86495073d97e6';
  const linha: Linha = {
    seq: 0,
    id: 'p:x:marco:018f5b3a-1a2b-7c3d-89ab-0123456789ab',
    tipo: 'marco',
    timestamp: '2026-01-01T00:00:00.000Z',
    agente: 'agente-teste',
    prevHash: anc,
    dados: { marcoTipo: 'inicio', alvo: 'hex:alvo:u1' },
  };
  const hashEsperado = '5ce118a3ce3e08d19f468921b45a37a3f06fa4751c3485bdb12fe01844cdd26f';

  test('ancora do manifesto é o hex fixo', () => {
    expect(ancora(manifesto)).toBe(anc);
  });

  test('hashLinha do elo é o hex fixo', () => {
    expect(hashLinha(linha)).toBe(hashEsperado);
  });

  test('reordenar as chaves da linha não muda o hash (JCS ordena)', () => {
    const reordenada = {
      dados: linha.dados,
      prevHash: linha.prevHash,
      agente: linha.agente,
      timestamp: linha.timestamp,
      tipo: linha.tipo,
      id: linha.id,
      seq: linha.seq,
    } as Linha;
    expect(hashLinha(reordenada)).toBe(hashEsperado);
  });

  test('property: ida e volta por JSON.parse(JSON.stringify(l)) preserva o hash', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (seq) => {
        const l: Linha = { ...linha, seq };
        const clonada = JSON.parse(JSON.stringify(l)) as Linha;
        expect(hashLinha(clonada)).toBe(hashLinha(l));
      }),
    );
  });
});

describe('proximoSeq / prevHashEsperado (relativo)', () => {
  test('proximoSeq sem último elo = número de pendentes', () => {
    expect(proximoSeq(null, 3)).toBe(3);
  });

  test('proximoSeq com último elo = seq + 1 + pendentes', () => {
    const elo = construirLinha(0, null);
    const comSeq5 = { ...elo, seq: 5 };
    expect(proximoSeq(comSeq5, 2)).toBe(8);
  });

  test('prevHashEsperado sem último elo = âncora do manifesto', () => {
    expect(prevHashEsperado(null, MANIFESTO)).toBe(ancora(MANIFESTO));
  });

  test('prevHashEsperado com último elo = hashLinha desse elo', () => {
    const elo = construirLinha(0, null);
    expect(prevHashEsperado(elo, MANIFESTO)).toBe(hashLinha(elo));
  });
});

describe('verificarCadeia (N1: log de 5 elos, corrupções pontuais)', () => {
  test('log íntegro de 5 elos verifica ok', () => {
    const log = construirLog(5);
    const resultado = verificarCadeia(paraTexto(log), MANIFESTO);
    expect(resultado).toEqual({
      ok: true,
      totalLinhas: 5,
      cabeca: hashLinha(log[4]),
      quebras: [],
      totalQuebras: 0,
      linhasReparadas: [],
    });
  });

  test('(a) JSON inválido na linha 1 → {1,linha-invalida},{2,hash-nao-bate}', () => {
    const log: Array<Linha | string> = [...construirLog(5)];
    log[1] = '{ isso nao e json valido';
    const resultado = verificarCadeia(paraTexto(log), MANIFESTO);
    expect(resultado.quebras).toEqual([
      { indice: 1, motivo: 'linha-invalida' },
      { indice: 2, motivo: 'hash-nao-bate' },
    ]);
    expect(resultado.totalQuebras).toBe(2);
    expect(resultado.linhasReparadas).toEqual([]);
    expect(resultado.ok).toBe(false);
  });

  test('(b) dados alterado na linha 1 → {2,hash-nao-bate}', () => {
    const log = construirLog(5);
    const alterado: Array<Linha | string> = [...log];
    alterado[1] = { ...log[1], dados: { ...log[1].dados, marcoTipo: 'alterado' } };
    const resultado = verificarCadeia(paraTexto(alterado), MANIFESTO);
    expect(resultado.quebras).toEqual([{ indice: 2, motivo: 'hash-nao-bate' }]);
    expect(resultado.totalQuebras).toBe(1);
  });

  test('(c) linha 1 removida → {1,seq-divergente},{1,hash-nao-bate}, sem cascata', () => {
    const log = construirLog(5);
    const semLinha1 = log.filter((_, indice) => indice !== 1);
    const resultado = verificarCadeia(paraTexto(semLinha1), MANIFESTO);
    expect(resultado.quebras).toEqual([
      { indice: 1, motivo: 'seq-divergente' },
      { indice: 1, motivo: 'hash-nao-bate' },
    ]);
    expect(resultado.totalQuebras).toBe(2);
  });

  test('(d) cauda parcial sem \\n no fim + novo elo legítimo → repara e continua a cadeia', () => {
    const log = construirLog(5);
    const textoIntegro = paraTexto(log);
    // simula: o escritor completa a cauda torta com '\n' antes de anexar o novo elo (§4.7).
    const caudaCompletada = `${textoIntegro}{"seq":5,"cauda":"bytes parciais sem fechamento"}\n`;
    const ultimoElo = log[4];
    const novoElo = construirLinha(5, ultimoElo);
    novoElo.seq = proximoSeq(ultimoElo, 1);
    novoElo.prevHash = prevHashEsperado(ultimoElo, MANIFESTO);
    const textoFinal = caudaCompletada + JSON.stringify(novoElo) + '\n';

    const resultado = verificarCadeia(textoFinal, MANIFESTO);
    expect(resultado.ok).toBe(true);
    expect(resultado.quebras).toEqual([]);
    expect(resultado.linhasReparadas).toEqual([5]);
    expect(novoElo.seq).toBe(6);
    expect(resultado.cabeca).toBe(hashLinha(novoElo));
  });

  test('(e) (a) + prevHash alterado na linha 4 → {1,linha-invalida},{2,hash-nao-bate},{4,hash-nao-bate}', () => {
    const log = construirLog(5);
    const alterado: Array<Linha | string> = [...log];
    alterado[1] = '{ isso nao e json valido';
    alterado[4] = { ...log[4], prevHash: sha256hex('lixo-qualquer') };
    const resultado = verificarCadeia(paraTexto(alterado), MANIFESTO);
    expect(resultado.quebras).toEqual([
      { indice: 1, motivo: 'linha-invalida' },
      { indice: 2, motivo: 'hash-nao-bate' },
      { indice: 4, motivo: 'hash-nao-bate' },
    ]);
    expect(resultado.totalQuebras).toBe(3);
  });

  test('(f) limite conhecido: lixo terminado em \\n + registrar legítimo → ok, reparado (indistinguível)', () => {
    const log = construirLog(5);
    const comLixo = `${paraTexto(log)}isto e lixo puro, nao e json\n`;
    const ultimoElo = log[4];
    const novoElo = construirLinha(5, ultimoElo);
    novoElo.seq = proximoSeq(ultimoElo, 1);
    novoElo.prevHash = prevHashEsperado(ultimoElo, MANIFESTO);
    const textoFinal = comLixo + JSON.stringify(novoElo) + '\n';

    const resultado = verificarCadeia(textoFinal, MANIFESTO);
    expect(resultado.ok).toBe(true);
    expect(resultado.linhasReparadas).toEqual([5]);
  });

  test('(g) (c) + registrar legítimo → só as 2 quebras de (c), sem quebras novas', () => {
    const log = construirLog(5);
    const semLinha1 = log.filter((_, indice) => indice !== 1);
    const ultimoElo = semLinha1[semLinha1.length - 1];
    const novoElo = construirLinha(9, ultimoElo);
    novoElo.seq = proximoSeq(ultimoElo, 0);
    novoElo.prevHash = prevHashEsperado(ultimoElo, MANIFESTO);
    const textoFinal = paraTexto([...semLinha1, novoElo]);

    const resultado = verificarCadeia(textoFinal, MANIFESTO);
    expect(resultado.quebras).toEqual([
      { indice: 1, motivo: 'seq-divergente' },
      { indice: 1, motivo: 'hash-nao-bate' },
    ]);
    expect(resultado.totalQuebras).toBe(2);
  });
});

describe('verificarCadeia: outros casos', () => {
  test('dados-invalidos: validarDados reprovando um elo gera a quebra', () => {
    const e0 = construirLinha(0, null);
    const e1 = construirLinha(1, e0, 'ruim');
    const validarDados = (_tipo: string, dados: Record<string, unknown>) =>
      dados.marcoTipo === 'ruim' ? [{ caminho: '/dados/marcoTipo', codigo: 'ruim', mensagem: 'x' }] : null;

    const resultado = verificarCadeia(paraTexto([e0, e1]), MANIFESTO, validarDados);
    expect(resultado.quebras).toEqual([{ indice: 1, motivo: 'dados-invalidos' }]);
    expect(resultado.ok).toBe(false);
  });

  test('transposição adjacente: quebras localizadas na janela afetada, recupera depois', () => {
    const log = construirLog(5);
    const transposto = [...log];
    [transposto[1], transposto[2]] = [transposto[2], transposto[1]];

    const resultado = verificarCadeia(paraTexto(transposto), MANIFESTO);
    expect(resultado.quebras).toEqual([
      { indice: 1, motivo: 'seq-divergente' },
      { indice: 1, motivo: 'hash-nao-bate' },
      { indice: 2, motivo: 'seq-divergente' },
      { indice: 2, motivo: 'hash-nao-bate' },
      { indice: 3, motivo: 'seq-divergente' },
      { indice: 3, motivo: 'hash-nao-bate' },
    ]);
    // o elo original (não tocado) volta a verificar: a quebra não cascateia até o fim.
    expect(resultado.quebras.some((quebra) => quebra.indice === 4)).toBe(false);
  });

  test('duplicata de elo: só a cópia anexada quebra, localizada no seu próprio índice', () => {
    const log = construirLog(5);
    const comDuplicata = [...log, log[2]];

    const resultado = verificarCadeia(paraTexto(comDuplicata), MANIFESTO);
    expect(resultado.quebras).toEqual([
      { indice: 5, motivo: 'seq-divergente' },
      { indice: 5, motivo: 'hash-nao-bate' },
    ]);
  });

  test('cauda sem \\n é ignorada: nem conta em totalLinhas nem quebra a cadeia', () => {
    const log = construirLog(2);
    const texto = `${paraTexto(log)}{"seq":2,"cauda":"sem newline no fim"`;

    const resultado = verificarCadeia(texto, MANIFESTO);
    expect(resultado.totalLinhas).toBe(2);
    expect(resultado.ok).toBe(true);
    expect(resultado.cabeca).toBe(hashLinha(log[1]));
  });

  test('cabeca é "" quando não há nenhum elo válido', () => {
    const resultado = verificarCadeia('lixo sem json\nmais lixo\n', MANIFESTO);
    expect(resultado.cabeca).toBe('');
    expect(resultado.quebras).toEqual([
      { indice: 0, motivo: 'linha-invalida' },
      { indice: 1, motivo: 'linha-invalida' },
    ]);
  });
});
