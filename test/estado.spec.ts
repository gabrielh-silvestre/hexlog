import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import type { Linha } from '../src/eventos.ts';
import {
  agoraEfetivo,
  projetar,
  validarCampo,
  VocabularioSchema,
  type Vocabulario,
} from '../src/estado.ts';

// ---- fixtures locais (duplicadas em estado.property.spec.ts: 2 arquivos só, sem 3º módulo) ----

const T = (n: number) => new Date(n * 60_000).toISOString();
const ALVO_1 = 'hex:alvo:u1';
const ALVO_2 = 'hex:alvo:u2';

const vocabularioVazio: Vocabulario = {
  nucleo: { marcoTipo: [], resultado: [], acao: [] },
  porDono: {},
};

let proximoSeqValor = 0;

function elo(args: {
  tipo: string;
  dados: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  seq?: number;
}): Linha {
  const numeroSeq = args.seq ?? proximoSeqValor++;
  return {
    seq: numeroSeq,
    id: args.id ?? `p:r:${args.tipo}:${randomUUIDv7()}`,
    tipo: args.tipo,
    timestamp: args.timestamp ?? T(numeroSeq),
    agente: 'teste',
    prevHash: '0'.repeat(64), // sintético: a projeção não verifica hash
    dados: args.dados,
  };
}

function marco(
  dados: {
    alvo: string;
    marcoTipo?: string;
    prazoExecucao?: string;
    decisoes?: { item: string; acao: string; texto: string }[];
  },
  opcoes: { id?: string; timestamp?: string; seq?: number } = {},
): Linha {
  const { marcoTipo = 'evento-teste', ...resto } = dados;
  return elo({ tipo: 'marco', dados: { marcoTipo, ...resto }, ...opcoes });
}

function veredito(
  dados: { destino: string; afirmacao: string; resultado?: string; supera?: string[] },
  opcoes: { id?: string; timestamp?: string; seq?: number } = {},
): Linha {
  const { resultado = 'confirmada', ...resto } = dados;
  return elo({
    tipo: 'veredito',
    dados: { fonte: 'f', prova: 'p', origem: 'o', rastro: 'r', resultado, ...resto },
    ...opcoes,
  });
}

// ---- testes ----

describe('projetar › Estado bate com fixture (envelope novo, alvo hex:alvo:*)', () => {
  test('marco + veredito confirmando produzem o Estado esperado', () => {
    const m1 = marco({ alvo: ALVO_1, marcoTipo: 'esqueleto-aberto' }, { timestamp: T(0) });
    const v1 = veredito(
      { destino: ALVO_1, afirmacao: 'dod-1', resultado: 'confirmada' },
      { timestamp: T(1) },
    );
    const elos = [m1, v1];
    const vocabulario: Vocabulario = {
      nucleo: { marcoTipo: ['esqueleto-aberto'], resultado: ['confirmada'], acao: [] },
      porDono: {},
    };

    expect(projetar(elos, vocabulario, agoraEfetivo(T(1), elos))).toEqual({
      logAte: { id: v1.id, seq: v1.seq, timestamp: v1.timestamp },
      vigentes: [{ destino: ALVO_1, afirmacao: 'dod-1', status: 'vigente', vigente: v1.id }],
      conflitos: [],
      orfaos: [],
      aRevisar: [],
      referenciasInvalidas: [],
      avisos: [],
    });
  });
});

describe('projetar › pureza', () => {
  test('mesmos argumentos produzem o mesmo resultado', () => {
    const v1 = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(0) });
    const elos = [v1];
    expect(projetar(elos, vocabularioVazio, T(0))).toEqual(projetar(elos, vocabularioVazio, T(0)));
  });

  test('rebuild completo repetido (replay incremental) bate com o rebuild direto', () => {
    const m1 = marco({ alvo: ALVO_1, prazoExecucao: T(10) }, { timestamp: T(0) });
    const v1 = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(1) });
    const v2 = veredito({ destino: ALVO_1, afirmacao: 'a2' }, { timestamp: T(2) });
    const elos = [m1, v1, v2];

    let ultimoReplay;
    for (let ate = 1; ate <= elos.length; ate++) {
      const parcial = elos.slice(0, ate);
      ultimoReplay = projetar(parcial, vocabularioVazio, agoraEfetivo(T(2), parcial));
    }

    expect(ultimoReplay).toEqual(projetar(elos, vocabularioVazio, agoraEfetivo(T(2), elos)));
  });
});

describe('projetar › dedupe por id', () => {
  test('evento duplicado por id não muda a Projeção', () => {
    const v1 = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(0) });
    const v2 = veredito({ destino: ALVO_1, afirmacao: 'a2' }, { timestamp: T(1) });
    const elos = [v1, v2];
    const comDuplicata = [v1, v1, v2];

    expect(projetar(comDuplicata, vocabularioVazio, T(1))).toEqual(
      projetar(elos, vocabularioVazio, T(1)),
    );
  });
});

describe('N3 › supersessão', () => {
  test('veredito único fica vigente', () => {
    const v1 = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(0) });
    const projecao = projetar([v1], vocabularioVazio, T(0));
    expect(projecao.vigentes).toEqual([
      { destino: ALVO_1, afirmacao: 'a1', status: 'vigente', vigente: v1.id },
    ]);
    expect(projecao.conflitos).toEqual([]);
  });

  test('dois vereditos concorrentes sem supera viram conflito', () => {
    const v1 = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(0) });
    const v2 = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(1) });
    const projecao = projetar([v1, v2], vocabularioVazio, T(1));
    expect(projecao.vigentes).toEqual([
      { destino: ALVO_1, afirmacao: 'a1', status: 'conflito', candidatos: [v1.id, v2.id] },
    ]);
    expect(projecao.conflitos).toEqual([
      { destino: ALVO_1, afirmacao: 'a1', candidatos: [v1.id, v2.id] },
    ]);
  });

  test('cadeia A<-B<-C: só C fica vigente (supera em cadeia)', () => {
    const a = veredito({ destino: ALVO_1, afirmacao: 'x' }, { timestamp: T(0) });
    const b = veredito({ destino: ALVO_1, afirmacao: 'x', supera: [a.id] }, { timestamp: T(1) });
    const c = veredito({ destino: ALVO_1, afirmacao: 'x', supera: [b.id] }, { timestamp: T(2) });
    const projecao = projetar([a, b, c], vocabularioVazio, T(2));
    expect(projecao.vigentes).toEqual([
      { destino: ALVO_1, afirmacao: 'x', status: 'vigente', vigente: c.id },
    ]);
  });

  test('supera cruzando destino/afirmação diferente não funde grupos', () => {
    const y = veredito({ destino: ALVO_2, afirmacao: 'A2' }, { timestamp: T(0) });
    const x = veredito({ destino: ALVO_1, afirmacao: 'A1', supera: [y.id] }, { timestamp: T(1) });
    const projecao = projetar([y, x], vocabularioVazio, T(1));
    expect(projecao.vigentes).toEqual([
      { destino: ALVO_1, afirmacao: 'A1', status: 'vigente', vigente: x.id },
    ]);
  });

  test('supera para id que não é Veredito do log vira referenciasInvalidas', () => {
    const marcoQualquer = marco({ alvo: ALVO_1 }, { timestamp: T(0) });
    const v1 = veredito(
      { destino: ALVO_1, afirmacao: 'a1', supera: [marcoQualquer.id] },
      { timestamp: T(1) },
    );
    const projecao = projetar([marcoQualquer, v1], vocabularioVazio, T(1));
    expect(projecao.referenciasInvalidas).toEqual([
      { citadaPor: v1.id, referencia: marcoQualquer.id },
    ]);
    expect(projecao.vigentes).toEqual([
      { destino: ALVO_1, afirmacao: 'a1', status: 'vigente', vigente: v1.id },
    ]);
  });

  test('supera para id inexistente vira referenciasInvalidas', () => {
    const v1 = veredito(
      { destino: ALVO_1, afirmacao: 'a1', supera: ['p:r:veredito:fantasma'] },
      { timestamp: T(0) },
    );
    const projecao = projetar([v1], vocabularioVazio, T(0));
    expect(projecao.referenciasInvalidas).toEqual([
      { citadaPor: v1.id, referencia: 'p:r:veredito:fantasma' },
    ]);
  });
});

describe('N3 › órfãos (relógio injetado)', () => {
  test('vencido pelo relógio do próprio log', () => {
    const abertura = marco({ alvo: ALVO_1, prazoExecucao: T(1) }, { timestamp: T(0) });
    const outro = veredito({ destino: ALVO_2, afirmacao: 'a1' }, { timestamp: T(3) });
    const elos = [abertura, outro];

    expect(projetar(elos, vocabularioVazio, agoraEfetivo(T(0), elos)).orfaos).toEqual([
      { marco: abertura.id, alvo: ALVO_1, prazoExecucao: T(1) },
    ]);
  });

  test('a tempo (agora ainda antes do prazo) não é órfão', () => {
    const abertura = marco({ alvo: ALVO_1, prazoExecucao: T(10) }, { timestamp: T(0) });
    expect(projetar([abertura], vocabularioVazio, T(1)).orfaos).toEqual([]);
  });

  test('pela parede: relógio injetado ultrapassa o prazo mesmo sem evento novo no log', () => {
    const abertura = marco({ alvo: ALVO_1, prazoExecucao: T(1) }, { timestamp: T(0) });
    const agora = agoraEfetivo(T(5), [abertura]);

    expect(projetar([abertura], vocabularioVazio, agora).orfaos).toEqual([
      { marco: abertura.id, alvo: ALVO_1, prazoExecucao: T(1) },
    ]);
  });
});

describe('N3 › aRevisar (com gate incluído)', () => {
  test('inclui eventos do mesmo alvo do veredito superado (marco e gate), exclui alvos não relacionados', () => {
    const v1 = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(0) });
    const m1 = marco({ alvo: ALVO_1, marcoTipo: 'comentario' }, { timestamp: T(1) });
    const gate1 = marco({ alvo: ALVO_1, marcoTipo: 'gate' }, { timestamp: T(2) });
    const v2 = veredito({ destino: ALVO_1, afirmacao: 'a1', supera: [v1.id] }, { timestamp: T(3) });
    const outraUnidade = marco({ alvo: ALVO_2, marcoTipo: 'comentario' }, { timestamp: T(4) });

    const projecao = projetar([v1, m1, gate1, v2, outraUnidade], vocabularioVazio, T(4));

    expect(projecao.aRevisar).toEqual(expect.arrayContaining([m1.id, gate1.id, v2.id]));
    expect(projecao.aRevisar).not.toEqual(expect.arrayContaining([v1.id]));
    expect(projecao.aRevisar).not.toEqual(expect.arrayContaining([outraUnidade.id]));
  });
});

describe('ciclo do Marco', () => {
  test('abre e permanece aberto (sem órfão) antes do prazo', () => {
    const abertura = marco({ alvo: ALVO_1, prazoExecucao: T(10) }, { timestamp: T(0) });
    expect(projetar([abertura], vocabularioVazio, T(1)).orfaos).toEqual([]);
  });

  test('fecha por Veredito no mesmo alvo', () => {
    const abertura = marco({ alvo: ALVO_1, prazoExecucao: T(1) }, { timestamp: T(0) });
    const fechamento = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(2) });
    expect(projetar([abertura, fechamento], vocabularioVazio, T(5)).orfaos).toEqual([]);
  });

  test('fecha por Marco sem prazoExecucao', () => {
    const abertura = marco({ alvo: ALVO_1, prazoExecucao: T(1) }, { timestamp: T(0) });
    const fechamento = marco({ alvo: ALVO_1 }, { timestamp: T(2) });
    expect(projetar([abertura, fechamento], vocabularioVazio, T(5)).orfaos).toEqual([]);
  });

  test('nova abertura reinicia o ciclo, ignorando o anterior', () => {
    const abertura1 = marco({ alvo: ALVO_1, prazoExecucao: T(1) }, { timestamp: T(0) });
    const fechamento = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(2) });
    const abertura2 = marco({ alvo: ALVO_1, prazoExecucao: T(20) }, { timestamp: T(3) });
    const elos = [abertura1, fechamento, abertura2];

    expect(projetar(elos, vocabularioVazio, T(4)).orfaos).toEqual([]);
    expect(projetar(elos, vocabularioVazio, T(25)).orfaos).toEqual([
      { marco: abertura2.id, alvo: ALVO_1, prazoExecucao: T(20) },
    ]);
  });
});

describe('N13 › R-3: Marco de gate não abre nem fecha', () => {
  test('Marco de gate sozinho não cria abertura', () => {
    const gate = marco({ alvo: ALVO_1, marcoTipo: 'gate' }, { timestamp: T(0) });
    expect(projetar([gate], vocabularioVazio, T(100)).orfaos).toEqual([]);
  });

  test('órfão persiste depois de um Marco de gate no mesmo alvo', () => {
    const abertura = marco({ alvo: ALVO_1, prazoExecucao: T(1) }, { timestamp: T(0) });
    const gate = marco({ alvo: ALVO_1, marcoTipo: 'gate' }, { timestamp: T(2) });
    const elos = [abertura, gate];

    expect(projetar(elos, vocabularioVazio, T(5)).orfaos).toEqual([
      { marco: abertura.id, alvo: ALVO_1, prazoExecucao: T(1) },
    ]);
  });
});

describe('avisos (N4): por dono e classes', () => {
  test('marcoTipo do núcleo não gera aviso', () => {
    const vocabulario: Vocabulario = {
      nucleo: { marcoTipo: ['abertura'], resultado: [], acao: [] },
      porDono: {},
    };
    const m1 = marco({ alvo: ALVO_1, marcoTipo: 'abertura' }, { timestamp: T(0) });
    expect(projetar([m1], vocabulario, T(0)).avisos).toEqual([]);
  });

  test('marcoTipo de extensão de um dono gera aviso com esse dono', () => {
    const vocabulario: Vocabulario = {
      nucleo: { marcoTipo: [], resultado: [], acao: [] },
      porDono: { 'dono-x': { marcoTipo: ['card-revisado'], resultado: [], acao: [] } },
    };
    const m1 = marco({ alvo: ALVO_1, marcoTipo: 'card-revisado' }, { timestamp: T(0) });
    expect(projetar([m1], vocabulario, T(0)).avisos).toEqual([
      {
        evento: m1.id,
        campo: 'marcoTipo',
        valor: 'card-revisado',
        classe: 'extensao',
        dono: 'dono-x',
      },
    ]);
  });

  test('marcoTipo declarado por dois donos vira extensão ambígua (dono null)', () => {
    const vocabulario: Vocabulario = {
      nucleo: { marcoTipo: [], resultado: [], acao: [] },
      porDono: {
        'dono-a': { marcoTipo: ['card-revisado'], resultado: [], acao: [] },
        'dono-b': { marcoTipo: ['card-revisado'], resultado: [], acao: [] },
      },
    };
    const m1 = marco({ alvo: ALVO_1, marcoTipo: 'card-revisado' }, { timestamp: T(0) });
    const [aviso] = projetar([m1], vocabulario, T(0)).avisos;
    expect(aviso).toEqual({
      evento: m1.id,
      campo: 'marcoTipo',
      valor: 'card-revisado',
      classe: 'extensao',
      dono: null,
    });
  });

  test('marcoTipo desconhecido (campo fechado) vira erro; resultado desconhecido (campo aberto) vira aviso-desconhecido', () => {
    const m1 = marco({ alvo: ALVO_1, marcoTipo: 'inedito' }, { timestamp: T(0) });
    const v1 = veredito(
      { destino: ALVO_1, afirmacao: 'a1', resultado: 'inedito' },
      { timestamp: T(1) },
    );
    expect(projetar([m1, v1], vocabularioVazio, T(1)).avisos).toEqual([
      { evento: m1.id, campo: 'marcoTipo', valor: 'inedito', classe: 'erro', dono: null },
      {
        evento: v1.id,
        campo: 'resultado',
        valor: 'inedito',
        classe: 'aviso-desconhecido',
        dono: null,
      },
    ]);
  });

  test('decisoes[].acao é validado por decisão', () => {
    const vocabulario: Vocabulario = {
      nucleo: { marcoTipo: ['evento-teste'], resultado: [], acao: ['aprovar'] },
      porDono: {},
    };
    const m1 = marco(
      {
        alvo: ALVO_1,
        decisoes: [
          { item: 'x', acao: 'aprovar', texto: 't' },
          { item: 'y', acao: 'rejeitar', texto: 't2' },
        ],
      },
      { timestamp: T(0) },
    );
    expect(projetar([m1], vocabulario, T(0)).avisos).toEqual([
      { evento: m1.id, campo: 'decisoes.acao', valor: 'rejeitar', classe: 'erro', dono: null },
    ]);
  });

  test('Marco de gate é ignorado nos avisos', () => {
    const m1 = marco({ alvo: ALVO_1, marcoTipo: 'gate' }, { timestamp: T(0) });
    expect(projetar([m1], vocabularioVazio, T(0)).avisos).toEqual([]);
  });
});

describe('validarCampo', () => {
  const vocabulario: Vocabulario = {
    nucleo: { marcoTipo: ['nucleo-tipo'], resultado: [], acao: [] },
    porDono: { d1: { marcoTipo: [], resultado: ['ext-resultado'], acao: [] } },
  };

  test('valor do núcleo devolve null (sem aviso)', () => {
    expect(validarCampo(vocabulario, 'marcoTipo', 'nucleo-tipo')).toBeNull();
  });

  test('valor de extensão de um dono devolve classe extensao com esse dono', () => {
    expect(validarCampo(vocabulario, 'resultado', 'ext-resultado')).toEqual({
      classe: 'extensao',
      dono: 'd1',
    });
  });

  test('resultado fora de tudo (campo aberto) devolve aviso-desconhecido', () => {
    expect(validarCampo(vocabulario, 'resultado', 'nunca-visto')).toEqual({
      classe: 'aviso-desconhecido',
      dono: null,
    });
  });

  test('marcoTipo fora de tudo (campo fechado) devolve erro', () => {
    expect(validarCampo(vocabulario, 'marcoTipo', 'nunca-visto')).toEqual({
      classe: 'erro',
      dono: null,
    });
  });
});

describe('agoraEfetivo (Q10)', () => {
  test('usa o relógio injetado quando é mais recente que o último elo', () => {
    const elos = [veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(0) })];
    expect(agoraEfetivo(T(5), elos)).toBe(T(5));
  });

  test('usa o timestamp do último elo quando é mais recente que o relógio injetado', () => {
    const elos = [veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(5) })];
    expect(agoraEfetivo(T(0), elos)).toBe(T(5));
  });

  test('sem elos, usa o relógio injetado', () => {
    expect(agoraEfetivo(T(3), [])).toBe(T(3));
  });
});

describe('VocabularioSchema', () => {
  test('aceita vocabulário válido', () => {
    const valido = {
      nucleo: { marcoTipo: ['a'], resultado: [], acao: [] },
      porDono: { 'dono-x': { marcoTipo: [], resultado: ['b'], acao: [] } },
    };
    expect(VocabularioSchema.safeParse(valido).success).toBe(true);
  });

  test('rejeita chave extra (strictObject)', () => {
    const invalido = { nucleo: { marcoTipo: [], resultado: [], acao: [] }, porDono: {}, extra: 1 };
    expect(VocabularioSchema.safeParse(invalido).success).toBe(false);
  });
});

describe('S3: eventos custom são inertes', () => {
  test('Estado com eventos custom intercalados é igual ao Estado sem eles (fora logAte)', () => {
    const v1 = veredito({ destino: ALVO_1, afirmacao: 'a1' }, { timestamp: T(0) });
    const custom = elo({ tipo: 'anotacao', dados: { texto: 'nota livre' }, timestamp: T(1) });
    const v2 = veredito({ destino: ALVO_1, afirmacao: 'a2' }, { timestamp: T(2) });
    const agora = T(2);

    const { logAte: _semLogAte, ...projecaoSemCustom } = projetar(
      [v1, v2],
      vocabularioVazio,
      agora,
    );
    const { logAte: _comLogAte, ...projecaoComCustom } = projetar(
      [v1, custom, v2],
      vocabularioVazio,
      agora,
    );

    expect(projecaoComCustom).toEqual(projecaoSemCustom);
  });
});
