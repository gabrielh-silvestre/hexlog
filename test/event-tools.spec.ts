import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import canonicalize from 'canonicalize';
import { isNil } from 'es-toolkit';
import { buscar } from '../src/search.ts';
import { anchor, expectedPrevHash, nextSeq, sha256hex, type Chain } from '../src/chain.ts';
import type { Manifesto } from '../src/definitions.ts';
import type { Linha } from '../src/events.ts';
import { escreverCorpus, gerarCorpus } from './fixtures/corpus.ts';
import { type Ambiente, criarAmbiente, esperarErro, registrarNucleo } from './helpers.ts';

type ResultadoChamada = Awaited<ReturnType<Ambiente['chamar']>>;

const PROJ = 'p1';
const PROC = 'proc1';
const AGENTE = 'agente-teste';
const PREFIXO_MARCO = `${PROJ}:${PROC}:marco`;
const PREFIXO_VEREDITO = `${PROJ}:${PROC}:veredito`;
const PREFIXO_NOTA = `${PROJ}:${PROC}:nota`;

const SCHEMA_CUSTOM = {
  type: 'object',
  properties: {
    nota: { type: 'string' },
    prioridade: { type: 'number', default: 1 },
    quando: { type: 'string', format: 'date-time' },
    categoria: { type: 'string', enum: ['a', 'b'] },
  },
  required: ['nota'],
  additionalProperties: false,
};

function dadosMarco(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { marcoTipo: 'aprovado', alvo: 'hex:alvo:u1', ...overrides };
}

function dadosVeredito(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    afirmacao: 'a',
    fonte: 'f',
    resultado: 'ok',
    prova: 'p',
    destino: 'hex:alvo:u1',
    origem: 'o',
    rastro: 'r',
    ...overrides,
  };
}

/** Vocabulário núcleo + tipo custom com `default`/`format: date-time`/`enum` + gate custom, e fixa o processo. */
async function preparar(ambiente: Ambiente, projeto: string, processo: string): Promise<void> {
  await registrarNucleo(ambiente, projeto);
  await ambiente.chamar('registrar_tipo', { projeto, nome: 'nota', schema: SCHEMA_CUSTOM });
  await ambiente.chamar('registrar_gate', {
    projeto,
    nome: 'gate-custom',
    criterio: 'critério custom qualquer',
  });
  await ambiente.chamar('criar_processo', { projeto, processo });
}

function lerManifesto(ambiente: Ambiente, projeto: string, processo: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(ambiente.dir, projeto, processo, 'processo.json'), 'utf8'),
  );
}

function escreverLog(
  ambiente: Ambiente,
  projeto: string,
  processo: string,
  linhas: (Linha | string)[],
): void {
  const texto =
    linhas.map((linha) => (typeof linha === 'string' ? linha : JSON.stringify(linha))).join('\n') +
    '\n';
  fs.writeFileSync(path.join(ambiente.dir, projeto, processo, 'eventos.jsonl'), texto);
}

function construirElo(manifesto: unknown, ultimoElo: Linha | null, indice: number): Linha {
  return {
    seq: nextSeq(ultimoElo, 0),
    id: `${PROJ}:${PROC}:marco:${randomUUIDv7()}`,
    tipo: 'marco',
    timestamp: new Date(Date.UTC(2026, 0, 1 + indice)).toISOString(),
    agente: AGENTE,
    prevHash: expectedPrevHash(ultimoElo, manifesto),
    dados: { marcoTipo: 'aprovado', alvo: 'hex:alvo:u1' },
  };
}

function construirLog(manifesto: unknown, quantidade: number): Linha[] {
  const linhas: Linha[] = [];
  let ultimoElo: Linha | null = null;
  for (let indice = 0; indice < quantidade; indice++) {
    const elo = construirElo(manifesto, ultimoElo, indice);
    linhas.push(elo);
    ultimoElo = elo;
  }
  return linhas;
}

function esperarDeduplicado(resultado: ResultadoChamada, seqEsperado: number): void {
  const corpo = resultado.structuredContent as { deduplicado: boolean; evento: Linha };
  expect(corpo.deduplicado).toBe(true);
  expect(corpo.evento.seq).toBe(seqEsperado);
}

let ambiente: Ambiente;

beforeEach(async () => {
  ambiente = await criarAmbiente();
});

afterEach(async () => {
  await ambiente.fechar();
});

describe('M1', () => {
  test('tools/list expõe as 10 tools, cada uma com inputSchema e outputSchema', async () => {
    const { tools } = await ambiente.cliente.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'avaliar_gate',
        'cadeia',
        'criar_processo',
        'estado',
        'eventos',
        'listar',
        'registrar',
        'registrar_gate',
        'registrar_tipo',
        'registrar_vocabulario',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });
});

describe('M2', () => {
  const NOMES_INVALIDOS = ['..', 'a/b', 'A', '', '-a', 'a'.repeat(64)];

  const CASOS: { tool: string; campo: string; base: Record<string, unknown> }[] = [
    {
      tool: 'registrar',
      campo: 'projeto',
      base: {
        projeto: PROJ,
        processo: PROC,
        id: PREFIXO_MARCO,
        agente: AGENTE,
        dados: dadosMarco(),
      },
    },
    {
      tool: 'registrar',
      campo: 'processo',
      base: {
        projeto: PROJ,
        processo: PROC,
        id: PREFIXO_MARCO,
        agente: AGENTE,
        dados: dadosMarco(),
      },
    },
    {
      tool: 'avaliar_gate',
      campo: 'projeto',
      base: {
        projeto: PROJ,
        processo: PROC,
        gate: 'sem-orfaos',
        agente: AGENTE,
        alvo: 'hex:alvo:u1',
      },
    },
    {
      tool: 'avaliar_gate',
      campo: 'processo',
      base: {
        projeto: PROJ,
        processo: PROC,
        gate: 'sem-orfaos',
        agente: AGENTE,
        alvo: 'hex:alvo:u1',
      },
    },
    { tool: 'estado', campo: 'projeto', base: { projeto: PROJ, processo: PROC } },
    { tool: 'estado', campo: 'processo', base: { projeto: PROJ, processo: PROC } },
    { tool: 'eventos', campo: 'projeto', base: { projeto: PROJ, processo: PROC } },
    { tool: 'eventos', campo: 'processo', base: { projeto: PROJ, processo: PROC } },
    { tool: 'cadeia', campo: 'projeto', base: { projeto: PROJ, processo: PROC } },
    { tool: 'cadeia', campo: 'processo', base: { projeto: PROJ, processo: PROC } },
  ];

  for (const { tool, campo, base } of CASOS) {
    for (const nomeInvalido of NOMES_INVALIDOS) {
      test(`${tool}({${campo}: ${JSON.stringify(nomeInvalido)}}) → Input validation error, árvore intacta`, async () => {
        const antes = ambiente.arvore();
        const resultado = await ambiente.chamar(tool, { ...base, [campo]: nomeInvalido });
        expect(resultado.isError).toBe(true);
        expect(resultado.content?.[0]?.text).toMatch(/^Input validation error/);
        expect(ambiente.arvore()).toEqual(antes);
      });
    }
  }
});

describe('M3', () => {
  const CASOS: { tool: string; args: Record<string, unknown> }[] = [
    {
      tool: 'registrar',
      args: {
        projeto: PROJ,
        processo: 'fantasma',
        id: `${PROJ}:fantasma:marco`,
        agente: AGENTE,
        dados: dadosMarco(),
      },
    },
    {
      tool: 'avaliar_gate',
      args: {
        projeto: PROJ,
        processo: 'fantasma',
        gate: 'sem-orfaos',
        agente: AGENTE,
        alvo: 'hex:alvo:u1',
      },
    },
    { tool: 'estado', args: { projeto: PROJ, processo: 'fantasma' } },
    { tool: 'eventos', args: { projeto: PROJ, processo: 'fantasma' } },
    { tool: 'cadeia', args: { projeto: PROJ, processo: 'fantasma' } },
  ];

  for (const { tool, args } of CASOS) {
    test(`${tool} em processo inexistente → PROCESSO_INEXISTENTE, sem criar diretório`, async () => {
      const resultado = await ambiente.chamar(tool, args);
      esperarErro(resultado, 'PROCESS_NOT_FOUND');
      expect(fs.existsSync(path.join(ambiente.dir, PROJ, 'fantasma'))).toBe(false);
    });
  }
});

describe('M7', () => {
  test('avaliar_gate com alvo fora do formato hex:alvo: → Input validation error', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'sem-orfaos',
      agente: AGENTE,
      alvo: 'u1',
    });
    expect(resultado.isError).toBe(true);
    expect(resultado.content?.[0]?.text).toMatch(/^Input validation error/);
  });

  test('registrar com id fora da gramática → ID_INVALIDO estruturado', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: 'lixo',
      agente: AGENTE,
      dados: dadosMarco(),
    });
    const corpo = esperarErro(resultado, 'INVALID_ID');
    expect(corpo.detalhes[0]?.path).toBe('/id');
  });
});

describe('M8', () => {
  test('eventos pagina 250 linhas em 3 páginas de até 100, em ordem, sem exceder o teto de caracteres', async () => {
    await preparar(ambiente, PROJ, PROC);
    for (let i = 0; i < 250; i++) {
      const resultado = await ambiente.chamar('registrar', {
        projeto: PROJ,
        processo: PROC,
        id: PREFIXO_MARCO,
        agente: AGENTE,
        dados: dadosMarco(),
      });
      expect(resultado.isError).not.toBe(true);
    }

    const paginas: { eventos: Linha[]; proximoCursor: number | null }[] = [];
    let cursor = 0;
    for (;;) {
      const resultado = await ambiente.chamar('eventos', {
        projeto: PROJ,
        processo: PROC,
        desde: cursor,
        limite: 100,
      });
      const corpo = resultado.structuredContent as {
        eventos: Linha[];
        proximoCursor: number | null;
      };
      paginas.push(corpo);
      if (isNil(corpo.proximoCursor)) break;
      cursor = corpo.proximoCursor;
    }

    expect(paginas).toHaveLength(3);
    const todos = paginas.flatMap((pagina) => pagina.eventos);
    expect(todos).toHaveLength(250);
    expect(todos.map((evento) => evento.seq)).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(paginas.at(-1)?.proximoCursor).toBeNull();
    for (const pagina of paginas) {
      if (pagina.eventos.length > 1) {
        expect(JSON.stringify(pagina.eventos).length).toBeLessThanOrEqual(24_000);
      }
    }
  });

  test('dados acima de 16 000 caracteres canônicos → EVENTO_INVALIDO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_NOTA,
      agente: AGENTE,
      dados: { nota: 'x'.repeat(17_000) },
    });
    const corpo = esperarErro(resultado, 'INVALID_EVENT');
    expect(corpo.detalhes.some((detalhe) => detalhe.code === 'too_big')).toBe(true);
  });

  test('estado com 150 vigentes → 100 itens na lista e totais.vigentes = 150', async () => {
    await preparar(ambiente, PROJ, PROC);
    for (let i = 0; i < 150; i++) {
      const resultado = await ambiente.chamar('registrar', {
        projeto: PROJ,
        processo: PROC,
        id: PREFIXO_VEREDITO,
        agente: AGENTE,
        dados: dadosVeredito({ destino: `hex:alvo:u${i}`, afirmacao: `a${i}` }),
      });
      expect(resultado.isError).not.toBe(true);
    }
    const resultado = await ambiente.chamar('estado', { projeto: PROJ, processo: PROC });
    const corpo = resultado.structuredContent as {
      vigentes: unknown[];
      totais: Record<string, number>;
    };
    expect(corpo.vigentes).toHaveLength(100);
    expect(corpo.totais.vigentes).toBe(150);
  });
});

describe('M9', () => {
  test('annotations das 5 tools de eventos batem com §4.12', async () => {
    const { tools } = await ambiente.cliente.listTools();
    const porNome = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));

    for (const nome of ['registrar', 'avaliar_gate']) {
      expect(porNome[nome]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    for (const nome of ['estado', 'eventos', 'cadeia']) {
      expect(porNome[nome]).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });
});

describe('M11', () => {
  test('g) paginação estável com ate: registrar entre páginas não desloca nem repete itens; ate além do arquivo → FILTRO_INVALIDO /ate', async () => {
    await preparar(ambiente, PROJ, PROC);
    const manifesto = lerManifesto(ambiente, PROJ, PROC) as Manifesto;
    const corpus = gerarCorpus({
      tamanho: 300,
      manifesto,
      vocabulario: manifesto.fixado.vocabulario,
    });
    escreverCorpus(path.join(ambiente.dir, PROJ, PROC, 'eventos.jsonl'), corpus.texto);

    const primeira = await ambiente.chamar('eventos', {
      projeto: PROJ,
      processo: PROC,
      busca: 'webhook',
      limite: 3,
    });
    const corpoPrimeira = primeira.structuredContent as {
      eventos: Linha[];
      ate: number;
      proximoCursor: number | null;
    };
    expect(corpoPrimeira.ate).toBe(corpus.linhas.length);

    // registrado entre páginas: com `ate` congelado, não deve aparecer nas páginas seguintes.
    const novo = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_VEREDITO,
      agente: AGENTE,
      dados: dadosVeredito({
        afirmacao: 'novo evento sobre webhook registrado entre as páginas',
        destino: 'hex:alvo:u1',
      }),
    });
    const idNovo = (novo.structuredContent as { evento: Linha }).evento.id;

    const paginas: Linha[] = [...corpoPrimeira.eventos];
    let cursor = corpoPrimeira.proximoCursor;
    while (!isNil(cursor)) {
      const pagina = await ambiente.chamar('eventos', {
        projeto: PROJ,
        processo: PROC,
        busca: 'webhook',
        limite: 3,
        ate: corpoPrimeira.ate,
        desde: cursor,
      });
      const corpo = pagina.structuredContent as { eventos: Linha[]; proximoCursor: number | null };
      paginas.push(...corpo.eventos);
      cursor = corpo.proximoCursor;
    }

    const candidatos = corpus.linhas.map((linha, indice) => ({ indice, linha }));
    const { resultados } = buscar(candidatos, 'webhook');
    expect(paginas.map((evento) => evento.id)).toEqual(
      resultados.map((resultado) => corpus.linhas[resultado.indice].id),
    );
    expect(paginas.map((evento) => evento.id)).not.toContain(idNovo);

    const alem = await ambiente.chamar('eventos', {
      projeto: PROJ,
      processo: PROC,
      ate: corpus.linhas.length + 1000,
    });
    const corpoAlem = esperarErro(alem, 'INVALID_FILTER');
    expect(corpoAlem.detalhes.some((detalhe) => detalhe.path === '/ate')).toBe(true);
  });

  test('h) regressão do modo cru: sem busca e sem filtros novos, a resposta é igual ao contrato anterior (M8) mais modo e ate', async () => {
    await preparar(ambiente, PROJ, PROC);
    for (let i = 0; i < 250; i++) {
      const resultado = await ambiente.chamar('registrar', {
        projeto: PROJ,
        processo: PROC,
        id: PREFIXO_MARCO,
        agente: AGENTE,
        dados: dadosMarco(),
      });
      expect(resultado.isError).not.toBe(true);
    }

    const paginas: { eventos: Linha[]; proximoCursor: number | null; modo: string; ate: number }[] =
      [];
    let cursor = 0;
    for (;;) {
      const resultado = await ambiente.chamar('eventos', {
        projeto: PROJ,
        processo: PROC,
        desde: cursor,
        limite: 100,
      });
      const corpo = resultado.structuredContent as {
        eventos: Linha[];
        proximoCursor: number | null;
        modo: string;
        ate: number;
      };
      expect(corpo.modo).toBe('cru');
      expect(corpo.ate).toBe(250);
      paginas.push(corpo);
      if (isNil(corpo.proximoCursor)) break;
      cursor = corpo.proximoCursor;
    }

    expect(paginas).toHaveLength(3);
    const todos = paginas.flatMap((pagina) => pagina.eventos);
    expect(todos).toHaveLength(250);
    expect(todos.map((evento) => evento.seq)).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(paginas.at(-1)?.proximoCursor).toBeNull();
    for (const pagina of paginas) {
      if (pagina.eventos.length > 1) {
        expect(JSON.stringify(pagina.eventos).length).toBeLessThanOrEqual(24_000);
      }
    }
  });

  test('i) linguagem natural: "problema com o webhook" cai para OR e devolve resultado não vazio', async () => {
    await preparar(ambiente, PROJ, PROC);
    const manifesto = lerManifesto(ambiente, PROJ, PROC) as Manifesto;
    const corpus = gerarCorpus({
      tamanho: 300,
      manifesto,
      vocabulario: manifesto.fixado.vocabulario,
    });
    escreverCorpus(path.join(ambiente.dir, PROJ, PROC, 'eventos.jsonl'), corpus.texto);

    const resultado = await ambiente.chamar('eventos', {
      projeto: PROJ,
      processo: PROC,
      busca: 'problema com o webhook',
      limite: 50,
    });
    const corpo = resultado.structuredContent as {
      modo: string;
      combinacao: string;
      eventos: Linha[];
    };
    expect(corpo.modo).toBe('busca');
    expect(corpo.combinacao).toBe('OR');
    expect(corpo.eventos.length).toBeGreaterThan(0);
  });
});

describe('M12', () => {
  test('b) marcoTipo fora do vocabulário → FILTRO_INVALIDO /marcoTipo sem ler o log; "gate" aceito; resultado fora do vocabulário é encontrado; sem casamento → vazio; apos ≥ antes → FILTRO_INVALIDO /apos', async () => {
    await preparar(ambiente, PROJ, PROC);
    const manifesto = lerManifesto(ambiente, PROJ, PROC) as Manifesto;
    const corpus = gerarCorpus({
      tamanho: 300,
      manifesto,
      vocabulario: manifesto.fixado.vocabulario,
    });
    escreverCorpus(path.join(ambiente.dir, PROJ, PROC, 'eventos.jsonl'), corpus.texto);

    const invalido = await ambiente.chamar('eventos', {
      projeto: PROJ,
      processo: PROC,
      marcoTipo: 'nao-existe',
    });
    const corpoErro = esperarErro(invalido, 'INVALID_FILTER');
    expect(corpoErro.detalhes.some((detalhe) => detalhe.path === '/marcoTipo')).toBe(true);
    const ultimoLogDeEventos = ambiente.registros
      .filter((registro) => registro.event === 'tool' && registro.nome === 'eventos')
      .at(-1);
    expect(ultimoLogDeEventos?.candidatos).toBeUndefined();

    const comGate = await ambiente.chamar('eventos', {
      projeto: PROJ,
      processo: PROC,
      marcoTipo: 'gate',
    });
    expect(comGate.isError).not.toBe(true);

    const foraDoVocab = await ambiente.chamar('eventos', {
      projeto: PROJ,
      processo: PROC,
      resultado: 'resultado-fora-do-vocabulario',
    });
    const corpoFora = foraDoVocab.structuredContent as { eventos: Linha[] };
    expect(corpoFora.eventos.length).toBeGreaterThan(0);

    const semCasamento = await ambiente.chamar('eventos', {
      projeto: PROJ,
      processo: PROC,
      resultado: 'nunca-usado-em-lugar-nenhum',
    });
    const corpoSemCasamento = semCasamento.structuredContent as { eventos: Linha[] };
    expect(corpoSemCasamento.eventos).toEqual([]);

    const intervaloInvalido = await ambiente.chamar('eventos', {
      projeto: PROJ,
      processo: PROC,
      apos: '2026-06-01T00:00:00.000Z',
      antes: '2026-01-01T00:00:00.000Z',
    });
    const corpoIntervalo = esperarErro(intervaloInvalido, 'INVALID_FILTER');
    expect(corpoIntervalo.detalhes.some((detalhe) => detalhe.path === '/apos')).toBe(true);
  });

  test('e) alvo sem "hex:alvo:" → Input validation error', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('eventos', {
      projeto: PROJ,
      processo: PROC,
      alvo: 'login',
    });
    expect(resultado.isError).toBe(true);
    expect(resultado.content?.[0]?.text ?? '').toContain('Input validation error');
  });
});

describe('N1', () => {
  async function logDe5(): Promise<Linha[]> {
    await preparar(ambiente, PROJ, PROC);
    const manifesto = lerManifesto(ambiente, PROJ, PROC);
    const linhas = construirLog(manifesto, 5);
    escreverLog(ambiente, PROJ, PROC, linhas);
    return linhas;
  }

  async function chamarCadeia(): Promise<Chain> {
    const resultado = await ambiente.chamar('cadeia', { projeto: PROJ, processo: PROC });
    return resultado.structuredContent as Chain;
  }

  test('(a) JSON inválido na linha 1', async () => {
    const linhas = await logDe5();
    escreverLog(ambiente, PROJ, PROC, [
      linhas[0],
      '{ json quebrado',
      linhas[2],
      linhas[3],
      linhas[4],
    ]);
    const cadeia = await chamarCadeia();
    expect(cadeia.totalQuebras).toBe(2);
    expect(cadeia.quebras).toEqual(
      expect.arrayContaining([
        { indice: 1, motivo: 'linha-invalida' },
        { indice: 2, motivo: 'hash-nao-bate' },
      ]),
    );
  });

  test('(b) texto livre alterado em dados da linha 1', async () => {
    const linhas = await logDe5();
    const alterada: Linha = {
      ...linhas[1],
      dados: { ...linhas[1].dados, marcoTipo: 'adulterado' },
    };
    escreverLog(ambiente, PROJ, PROC, [linhas[0], alterada, linhas[2], linhas[3], linhas[4]]);
    const cadeia = await chamarCadeia();
    expect(cadeia.quebras).toEqual([{ indice: 2, motivo: 'hash-nao-bate' }]);
    expect(cadeia.totalQuebras).toBe(1);
  });

  test('(c) linha 1 removida, sem cascata nos elos seguintes', async () => {
    const linhas = await logDe5();
    escreverLog(ambiente, PROJ, PROC, [linhas[0], linhas[2], linhas[3], linhas[4]]);
    const cadeia = await chamarCadeia();
    expect(cadeia.totalQuebras).toBe(2);
    expect(cadeia.quebras).toEqual(
      expect.arrayContaining([
        { indice: 1, motivo: 'seq-divergente' },
        { indice: 1, motivo: 'hash-nao-bate' },
      ]),
    );
  });

  test('(d) bytes parciais sem \\n no fim + novo registrar → repara e encadeia', async () => {
    const linhas = await logDe5();
    const texto =
      linhas.map((linha) => JSON.stringify(linha)).join('\n') +
      '\n' +
      JSON.stringify(linhas[0]).slice(0, 10);
    fs.writeFileSync(path.join(ambiente.dir, PROJ, PROC, 'eventos.jsonl'), texto);

    const registrado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco(),
    });
    expect((registrado.structuredContent as { evento: Linha }).evento.seq).toBe(6);

    const cadeia = await chamarCadeia();
    expect(cadeia.ok).toBe(true);
    expect(cadeia.quebras).toEqual([]);
    expect(cadeia.linhasReparadas).toEqual([5]);
  });

  test('(e) (a) + prevHash alterado na linha 4', async () => {
    const linhas = await logDe5();
    const linha4Alterada: Linha = { ...linhas[4], prevHash: '0'.repeat(64) };
    escreverLog(ambiente, PROJ, PROC, [
      linhas[0],
      '{ json quebrado',
      linhas[2],
      linhas[3],
      linha4Alterada,
    ]);
    const cadeia = await chamarCadeia();
    expect(cadeia.totalQuebras).toBe(3);
    expect(cadeia.quebras).toEqual(
      expect.arrayContaining([
        { indice: 1, motivo: 'linha-invalida' },
        { indice: 2, motivo: 'hash-nao-bate' },
        { indice: 4, motivo: 'hash-nao-bate' },
      ]),
    );
  });

  test('(f) lixo com \\n anexado ao fim + registrar legítimo → repara', async () => {
    const linhas = await logDe5();
    const texto =
      linhas.map((linha) => JSON.stringify(linha)).join('\n') + '\n' + 'lixo qualquer\n';
    fs.writeFileSync(path.join(ambiente.dir, PROJ, PROC, 'eventos.jsonl'), texto);

    await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco(),
    });

    const cadeia = await chamarCadeia();
    expect(cadeia.ok).toBe(true);
    expect(cadeia.linhasReparadas).toEqual([5]);
  });

  test('(g) (c) seguido de registrar legítimo → nenhuma quebra além das 2 de (c)', async () => {
    const linhas = await logDe5();
    escreverLog(ambiente, PROJ, PROC, [linhas[0], linhas[2], linhas[3], linhas[4]]);

    await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco(),
    });

    const cadeia = await chamarCadeia();
    expect(cadeia.totalQuebras).toBe(2);
    expect(cadeia.quebras).toEqual(
      expect.arrayContaining([
        { indice: 1, motivo: 'seq-divergente' },
        { indice: 1, motivo: 'hash-nao-bate' },
      ]),
    );
  });
});

describe('N2', () => {
  test('(i) Marco com prazoExecucao em offset reenviado igual → deduplicado, mesmo seq, sem nova linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const dados = dadosMarco({ prazoExecucao: '2026-09-16T18:00:00-03:00' });
    const primeiro = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados,
    });
    const corpo1 = primeiro.structuredContent as { evento: Linha };
    const antes = ambiente.arvore();

    const segundo = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: corpo1.evento.id,
      agente: AGENTE,
      dados,
    });
    esperarDeduplicado(segundo, corpo1.evento.seq);
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('(ii) tipo custom com default omitido, reenviado omitido ou explícito → deduplicado', async () => {
    await preparar(ambiente, PROJ, PROC);
    const primeiro = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_NOTA,
      agente: AGENTE,
      dados: { nota: 'x' },
    });
    const corpo1 = primeiro.structuredContent as { evento: Linha };

    const reenviadoOmitido = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: corpo1.evento.id,
      agente: AGENTE,
      dados: { nota: 'x' },
    });
    esperarDeduplicado(reenviadoOmitido, corpo1.evento.seq);

    const reenviadoExplicito = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: corpo1.evento.id,
      agente: AGENTE,
      dados: { nota: 'x', prioridade: 1 },
    });
    esperarDeduplicado(reenviadoExplicito, corpo1.evento.seq);
  });

  test('conteúdo diferente com o mesmo id completo → ID_CONFLITANTE', async () => {
    await preparar(ambiente, PROJ, PROC);
    const primeiro = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco(),
    });
    const corpo1 = primeiro.structuredContent as { evento: Linha };

    const conflitante = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: corpo1.evento.id,
      agente: AGENTE,
      dados: dadosMarco({ alvo: 'hex:alvo:outro' }),
    });
    esperarErro(conflitante, 'CONFLICTING_ID');
  });
});

describe('N4', () => {
  test('marcoTipo fora do vocabulário fixado → VOCABULARIO_VIOLADO, sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco({ marcoTipo: 'desconhecido' }),
    });
    esperarErro(resultado, 'VOCABULARY_VIOLATED');
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('decisoes[].acao fora do vocabulário fixado → VOCABULARIO_VIOLADO, sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco({ decisoes: [{ item: 'i', acao: 'fora-do-vocab', texto: 't' }] }),
    });
    esperarErro(resultado, 'VOCABULARY_VIOLATED');
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('resultado fora do vocabulário → grava e devolve aviso VOCABULARIO_DESCONHECIDO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_VEREDITO,
      agente: AGENTE,
      dados: dadosVeredito({ resultado: 'desconhecido' }),
    });
    expect(resultado.isError).not.toBe(true);
    const corpo = resultado.structuredContent as { avisos: { codigo: string }[] };
    expect(corpo.avisos).toEqual(
      expect.arrayContaining([expect.objectContaining({ codigo: 'VOCABULARIO_DESCONHECIDO' })]),
    );
  });
});

describe('N5', () => {
  test('sem-orfaos: estado limpo passa, Marco vencido reprova com prova', async () => {
    await preparar(ambiente, PROJ, PROC);
    const limpo = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'sem-orfaos',
      agente: AGENTE,
      alvo: 'hex:alvo:u1',
    });
    const corpoLimpo = limpo.structuredContent as { passou: boolean; prova: unknown[] };
    expect(corpoLimpo.passou).toBe(true);
    expect(corpoLimpo.prova).toEqual([]);

    ambiente.definirRelogio(new Date('2026-06-01T00:00:00.000Z'));
    await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco({ alvo: 'hex:alvo:u2', prazoExecucao: '2026-01-01T00:00:00.000Z' }),
    });

    const violado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'sem-orfaos',
      agente: AGENTE,
      alvo: 'hex:alvo:u2',
    });
    const corpoViolado = violado.structuredContent as { passou: boolean; prova: unknown[] };
    expect(corpoViolado.passou).toBe(false);
    expect(corpoViolado.prova.length).toBeGreaterThan(0);
  });

  test('cadeia-integra passa num log íntegro', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'cadeia-integra',
      agente: AGENTE,
      alvo: 'hex:alvo:u1',
    });
    expect((resultado.structuredContent as { passou: boolean }).passou).toBe(true);
  });
});

describe('N6', () => {
  test('gate custom sem resultado → AVALIACAO_INVALIDA', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'gate-custom',
      agente: AGENTE,
      alvo: 'hex:alvo:u1',
    });
    esperarErro(resultado, 'INVALID_EVALUATION');
  });

  test('gate embutido com resultado informado → AVALIACAO_INVALIDA', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'sem-orfaos',
      agente: AGENTE,
      alvo: 'hex:alvo:u1',
      resultado: { passou: true, prova: 'ok' },
    });
    esperarErro(resultado, 'INVALID_EVALUATION');
  });

  test('gate não fixado, nem embutido nem no snapshot → GATE_NAO_REGISTRADO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'fantasma',
      agente: AGENTE,
      alvo: 'hex:alvo:u1',
      resultado: { passou: true, prova: 'ok' },
    });
    esperarErro(resultado, 'GATE_NOT_REGISTERED');
  });

  test('gate registrado depois de criar_processo → GATE_NAO_REGISTRADO', async () => {
    await preparar(ambiente, PROJ, PROC);
    await ambiente.chamar('registrar_gate', {
      projeto: PROJ,
      nome: 'gate-tardio',
      criterio: 'critério tardio',
    });
    const resultado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'gate-tardio',
      agente: AGENTE,
      alvo: 'hex:alvo:u1',
      resultado: { passou: true, prova: 'ok' },
    });
    esperarErro(resultado, 'GATE_NOT_REGISTERED');
  });

  test('gate custom aceito → Marco de gate com criterio do snapshot e origem custom', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'gate-custom',
      agente: AGENTE,
      alvo: 'hex:alvo:u1',
      resultado: { passou: false, prova: ['evidência'] },
    });
    expect(resultado.isError).not.toBe(true);
    const corpo = resultado.structuredContent as { evento: Linha };
    const dados = corpo.evento.dados as {
      marcoTipo: string;
      gate: { nome: string; origem: string; criterio: string; passou: boolean };
    };
    expect(dados.marcoTipo).toBe('gate');
    expect(dados.gate.origem).toBe('custom');
    expect(dados.gate.criterio).toBe('critério custom qualquer');
    expect(dados.gate.passou).toBe(false);
  });
});

describe('N8', () => {
  test('timestamp termina em Z; prazoExecucao com offset é normalizado para UTC', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco({ prazoExecucao: '2026-09-16T18:00:00-03:00' }),
    });
    const corpo = resultado.structuredContent as { evento: Linha };
    expect(corpo.evento.timestamp).toMatch(/Z$/);
    expect((corpo.evento.dados as { prazoExecucao: string }).prazoExecucao).toBe(
      '2026-09-16T21:00:00.000Z',
    );
  });
});

describe('N9', () => {
  test('prefixo gera id no formato projeto:processo:tipo:uuidv7', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco(),
    });
    const corpo = resultado.structuredContent as { evento: Linha };
    expect(corpo.evento.id).toMatch(new RegExp(`^${PROJ}:${PROC}:marco:[0-9a-f-]{36}$`));
  });

  test('projeto/processo do id divergente dos parâmetros → ID_INVALIDO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: `outro-projeto:${PROC}:marco`,
      agente: AGENTE,
      dados: dadosMarco(),
    });
    esperarErro(resultado, 'INVALID_ID');
  });

  test('tipo não fixado no processo → TIPO_NAO_FIXADO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: `${PROJ}:${PROC}:fantasma`,
      agente: AGENTE,
      dados: { x: 1 },
    });
    esperarErro(resultado, 'TYPE_NOT_PINNED');
  });

  test('id completo inexistente → ID_DESCONHECIDO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: `${PREFIXO_MARCO}:${randomUUIDv7()}`,
      agente: AGENTE,
      dados: dadosMarco(),
    });
    esperarErro(resultado, 'UNKNOWN_ID');
  });
});

describe('N12', () => {
  test.each(['u1', 'hex:alvo:', 'hex:alvo:a:b', 'hex:alvo:a b', 'hex:outro:x'])(
    'alvo %s inválido em Marco → EVENTO_INVALIDO em /dados/alvo, sem linha',
    async (alvoInvalido) => {
      await preparar(ambiente, PROJ, PROC);
      const antes = ambiente.arvore();
      const resultado = await ambiente.chamar('registrar', {
        projeto: PROJ,
        processo: PROC,
        id: PREFIXO_MARCO,
        agente: AGENTE,
        dados: dadosMarco({ alvo: alvoInvalido }),
      });
      const corpo = esperarErro(resultado, 'INVALID_EVENT');
      expect(corpo.detalhes).toContainEqual(expect.objectContaining({ path: '/dados/alvo' }));
      expect(ambiente.arvore()).toEqual(antes);
    },
  );

  test('destino inválido em Veredito → EVENTO_INVALIDO em /dados/destino', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_VEREDITO,
      agente: AGENTE,
      dados: dadosVeredito({ destino: 'hex:outro:x' }),
    });
    const corpo = esperarErro(resultado, 'INVALID_EVENT');
    expect(corpo.detalhes).toContainEqual(expect.objectContaining({ path: '/dados/destino' }));
  });

  test('hex:alvo:u1 é aceito', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco(),
    });
    expect(resultado.isError).not.toBe(true);
  });

  test('avaliar_gate com alvo: "u1" → Input validation error, sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const resultado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'sem-orfaos',
      agente: AGENTE,
      alvo: 'u1',
    });
    expect(resultado.isError).toBe(true);
    expect(resultado.content?.[0]?.text).toMatch(/^Input validation error/);
    expect(ambiente.arvore()).toEqual(antes);
  });
});

describe('N13', () => {
  test('Marco vencido gera órfão; avaliar_gate não o remove de estado.orfaos', async () => {
    await preparar(ambiente, PROJ, PROC);
    ambiente.definirRelogio(new Date('2026-06-01T00:00:00.000Z'));
    await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco({ alvo: 'hex:alvo:x', prazoExecucao: '2026-01-01T00:00:00.000Z' }),
    });

    const antes = await ambiente.chamar('estado', {
      projeto: PROJ,
      processo: PROC,
      secoes: ['orfaos'],
    });
    expect((antes.structuredContent as { orfaos: unknown[] }).orfaos).toHaveLength(1);

    const avaliado = await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'sem-orfaos',
      agente: AGENTE,
      alvo: 'hex:alvo:x',
    });
    expect((avaliado.structuredContent as { passou: boolean }).passou).toBe(false);

    const depois = await ambiente.chamar('estado', {
      projeto: PROJ,
      processo: PROC,
      secoes: ['orfaos'],
    });
    expect((depois.structuredContent as { orfaos: unknown[] }).orfaos).toHaveLength(1);
  });

  test('Marco de gate sozinho num alvo não cria abertura', async () => {
    await preparar(ambiente, PROJ, PROC);
    await ambiente.chamar('avaliar_gate', {
      projeto: PROJ,
      processo: PROC,
      gate: 'sem-orfaos',
      agente: AGENTE,
      alvo: 'hex:alvo:y',
    });

    ambiente.definirRelogio(new Date('2099-01-01T00:00:00.000Z'));
    const resultado = await ambiente.chamar('estado', {
      projeto: PROJ,
      processo: PROC,
      secoes: ['orfaos'],
    });
    const orfaos = (resultado.structuredContent as { orfaos: { alvo: string }[] }).orfaos;
    expect(orfaos.some((orfao) => orfao.alvo === 'hex:alvo:y')).toBe(false);
  });
});

describe('N14', () => {
  test('prevHash do 1º elo é a âncora de processo.json', async () => {
    await preparar(ambiente, PROJ, PROC);
    const registrado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco(),
    });
    const evento = (registrado.structuredContent as { evento: Linha }).evento;
    expect(evento.prevHash).toBe(anchor(lerManifesto(ambiente, PROJ, PROC)));
  });

  test('fixado alterado com hashes recalculados → cadeia.quebras inclui {0, hash-nao-bate}', async () => {
    await preparar(ambiente, PROJ, PROC);
    await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco(),
    });

    const caminhoManifesto = path.join(ambiente.dir, PROJ, PROC, 'processo.json');
    const manifesto = JSON.parse(fs.readFileSync(caminhoManifesto, 'utf8')) as {
      fixado: { vocabulario: { nucleo: { marcoTipo: string[] } } };
      hashes: { schemas: string; vocabulario: string; gates: string };
    };
    manifesto.fixado.vocabulario.nucleo.marcoTipo.push('outro-valor');
    manifesto.hashes.vocabulario = sha256hex(canonicalize(manifesto.fixado.vocabulario) ?? '');
    fs.writeFileSync(caminhoManifesto, JSON.stringify(manifesto, null, 2));

    const cadeia = (await ambiente.chamar('cadeia', { projeto: PROJ, processo: PROC }))
      .structuredContent as Chain;
    expect(cadeia.quebras).toEqual(
      expect.arrayContaining([{ indice: 0, motivo: 'hash-nao-bate' }]),
    );
  });
});

describe('S2', () => {
  test('evento custom válido vira elo', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_NOTA,
      agente: AGENTE,
      dados: { nota: 'ok', categoria: 'a' },
    });
    expect(resultado.isError).not.toBe(true);
  });

  test('chave extra → EVENTO_INVALIDO em /dados/..., sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_NOTA,
      agente: AGENTE,
      dados: { nota: 'ok', extra: 1 },
    });
    const corpo = esperarErro(resultado, 'INVALID_EVENT');
    expect(corpo.detalhes[0]?.path.startsWith('/dados')).toBe(true);
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('enum inválido → EVENTO_INVALIDO em /dados/categoria', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_NOTA,
      agente: AGENTE,
      dados: { nota: 'ok', categoria: 'fora' },
    });
    const corpo = esperarErro(resultado, 'INVALID_EVENT');
    expect(corpo.detalhes).toContainEqual(expect.objectContaining({ path: '/dados/categoria' }));
  });

  test('format date-time inválido → EVENTO_INVALIDO em /dados/quando', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_NOTA,
      agente: AGENTE,
      dados: { nota: 'ok', quando: 'não-é-data' },
    });
    const corpo = esperarErro(resultado, 'INVALID_EVENT');
    expect(corpo.detalhes).toContainEqual(expect.objectContaining({ path: '/dados/quando' }));
  });
});

describe('S3', () => {
  test('eventos custom aparecem em eventos e ficam inertes na projeção do Estado', async () => {
    await preparar(ambiente, PROJ, PROC);

    await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: dadosMarco({ alvo: 'hex:alvo:a', prazoExecucao: '2025-01-01T00:00:00.000Z' }),
    });
    await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_NOTA,
      agente: AGENTE,
      dados: { nota: 'intercalado' },
    });
    await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_VEREDITO,
      agente: AGENTE,
      dados: dadosVeredito({ destino: 'hex:alvo:a', afirmacao: 'a1' }),
    });

    const eventos = (await ambiente.chamar('eventos', { projeto: PROJ, processo: PROC }))
      .structuredContent as { eventos: Linha[] };
    expect(eventos.eventos.map((evento) => evento.tipo)).toEqual(['marco', 'nota', 'veredito']);

    const estado = (await ambiente.chamar('estado', { projeto: PROJ, processo: PROC }))
      .structuredContent as {
      vigentes: unknown[];
      orfaos: unknown[];
      conflitos: unknown[];
      aRevisar: unknown[];
      referenciasInvalidas: unknown[];
    };
    // o Veredito fecha o ciclo do Marco: sem o custom intercalado no meio, o resultado seria idêntico.
    expect(estado.vigentes).toHaveLength(1);
    expect(estado.orfaos).toEqual([]);
    expect(estado.conflitos).toEqual([]);
    expect(estado.aRevisar).toEqual([]);
    expect(estado.referenciasInvalidas).toEqual([]);
  });
});

describe('S5', () => {
  test('schema, vocabulário e gate alterados entre a criação de dois processos: cada um usa sua versão', async () => {
    const projeto = 'p-s5';
    const schemaAntigo = {
      type: 'object',
      properties: { nota: { type: 'string' } },
      required: ['nota'],
      additionalProperties: false,
    };
    const schemaNovo = {
      type: 'object',
      properties: { nota: { type: 'string' }, extra: { type: 'string' } },
      required: ['nota'],
      additionalProperties: false,
    };

    await ambiente.chamar('registrar_vocabulario', {
      projeto,
      dono: 'nucleo',
      marcoTipo: ['v1'],
      resultado: [],
      acao: [],
    });
    await ambiente.chamar('registrar_tipo', { projeto, nome: 'nota', schema: schemaAntigo });
    await ambiente.chamar('registrar_gate', { projeto, nome: 'g', criterio: 'v1' });
    await ambiente.chamar('criar_processo', { projeto, processo: 'proc-antigo' });

    await ambiente.chamar('registrar_vocabulario', {
      projeto,
      dono: 'nucleo',
      marcoTipo: ['v2'],
      resultado: [],
      acao: [],
    });
    await ambiente.chamar('registrar_tipo', { projeto, nome: 'nota', schema: schemaNovo });
    await ambiente.chamar('registrar_gate', { projeto, nome: 'g', criterio: 'v2' });
    await ambiente.chamar('criar_processo', { projeto, processo: 'proc-novo' });

    const antigoV1 = await ambiente.chamar('registrar', {
      projeto,
      processo: 'proc-antigo',
      id: `${projeto}:proc-antigo:marco`,
      agente: AGENTE,
      dados: { marcoTipo: 'v1', alvo: 'hex:alvo:u1' },
    });
    expect(antigoV1.isError).not.toBe(true);

    const antigoV2 = await ambiente.chamar('registrar', {
      projeto,
      processo: 'proc-antigo',
      id: `${projeto}:proc-antigo:marco`,
      agente: AGENTE,
      dados: { marcoTipo: 'v2', alvo: 'hex:alvo:u1' },
    });
    esperarErro(antigoV2, 'VOCABULARY_VIOLATED');

    const novoV2 = await ambiente.chamar('registrar', {
      projeto,
      processo: 'proc-novo',
      id: `${projeto}:proc-novo:marco`,
      agente: AGENTE,
      dados: { marcoTipo: 'v2', alvo: 'hex:alvo:u1' },
    });
    expect(novoV2.isError).not.toBe(true);

    const novoExtra = await ambiente.chamar('registrar', {
      projeto,
      processo: 'proc-novo',
      id: `${projeto}:proc-novo:nota`,
      agente: AGENTE,
      dados: { nota: 'x', extra: 'y' },
    });
    expect(novoExtra.isError).not.toBe(true);

    const antigoExtra = await ambiente.chamar('registrar', {
      projeto,
      processo: 'proc-antigo',
      id: `${projeto}:proc-antigo:nota`,
      agente: AGENTE,
      dados: { nota: 'x', extra: 'y' },
    });
    esperarErro(antigoExtra, 'INVALID_EVENT');

    const gateAntigo = (
      await ambiente.chamar('avaliar_gate', {
        projeto,
        processo: 'proc-antigo',
        gate: 'g',
        agente: AGENTE,
        alvo: 'hex:alvo:u1',
        resultado: { passou: true, prova: 'ok' },
      })
    ).structuredContent as { evento: Linha };
    expect((gateAntigo.evento.dados as { gate: { criterio: string } }).gate.criterio).toBe('v1');

    const gateNovo = (
      await ambiente.chamar('avaliar_gate', {
        projeto,
        processo: 'proc-novo',
        gate: 'g',
        agente: AGENTE,
        alvo: 'hex:alvo:u1',
        resultado: { passou: true, prova: 'ok' },
      })
    ).structuredContent as { evento: Linha };
    expect((gateNovo.evento.dados as { gate: { criterio: string } }).gate.criterio).toBe('v2');
  });
});

describe('RESERVED_FIELD', () => {
  test('Marco com marcoTipo "gate" → CAMPO_RESERVADO, sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: { marcoTipo: 'gate', alvo: 'hex:alvo:u1', gate: { nome: 'x' } },
    });
    esperarErro(resultado, 'RESERVED_FIELD');
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('Marco com chave "gate", mesmo sem marcoTipo "gate" → CAMPO_RESERVADO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const resultado = await ambiente.chamar('registrar', {
      projeto: PROJ,
      processo: PROC,
      id: PREFIXO_MARCO,
      agente: AGENTE,
      dados: { marcoTipo: 'aprovado', alvo: 'hex:alvo:u1', gate: 'qualquer' },
    });
    esperarErro(resultado, 'RESERVED_FIELD');
  });
});
