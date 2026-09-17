import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import canonicalize from 'canonicalize';
import { isNil } from 'es-toolkit';
import { search as runSearch } from '../src/search.ts';
import { anchor, expectedPrevHash, nextSeq, sha256hex, type Chain } from '../src/chain.ts';
import type { ProcessManifest } from '../src/definitions.ts';
import type { EventLine } from '../src/events.ts';
import { escreverCorpus, gerarCorpus } from './fixtures/corpus.ts';
import { type Ambiente, criarAmbiente, esperarErro, registrarNucleo } from './helpers.ts';

type ResultadoChamada = Awaited<ReturnType<Ambiente['chamar']>>;

const PROJ = 'p1';
const PROC = 'proc1';
const AGENTE = 'agent-teste';
const PREFIXO_MILESTONE = `${PROJ}:${PROC}:milestone`;
const PREFIXO_VERDICT = `${PROJ}:${PROC}:verdict`;
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
  return { milestoneType: 'aprovado', target: 'hex:target:u1', ...overrides };
}

function dadosVeredito(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claim: 'a',
    source: 'f',
    result: 'ok',
    evidence: 'p',
    target: 'hex:target:u1',
    origin: 'o',
    trace: 'r',
    ...overrides,
  };
}

/** Vocabulário núcleo + tipo custom com `default`/`format: date-time`/`enum` + gate custom, e fixa o process. */
async function preparar(ambiente: Ambiente, project: string, process: string): Promise<void> {
  await registrarNucleo(ambiente, project);
  await ambiente.chamar('registrar_tipo', { project, name: 'nota', schema: SCHEMA_CUSTOM });
  await ambiente.chamar('registrar_gate', {
    project,
    name: 'gate-custom',
    criteria: 'critério custom qualquer',
  });
  await ambiente.chamar('criar_processo', { project, process });
}

function lerManifesto(ambiente: Ambiente, project: string, process: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(ambiente.dir, project, process, 'process.json'), 'utf8'),
  );
}

function escreverLog(
  ambiente: Ambiente,
  project: string,
  process: string,
  linhas: (EventLine | string)[],
): void {
  const texto =
    linhas.map((linha) => (typeof linha === 'string' ? linha : JSON.stringify(linha))).join('\n') +
    '\n';
  fs.writeFileSync(path.join(ambiente.dir, project, process, 'events.jsonl'), texto);
}

function construirElo(manifesto: unknown, ultimoElo: EventLine | null, indice: number): EventLine {
  return {
    seq: nextSeq(ultimoElo, 0),
    id: `${PROJ}:${PROC}:milestone:${randomUUIDv7()}`,
    type: 'milestone',
    timestamp: new Date(Date.UTC(2026, 0, 1 + indice)).toISOString(),
    agent: AGENTE,
    prevHash: expectedPrevHash(ultimoElo, manifesto),
    data: { milestoneType: 'aprovado', target: 'hex:target:u1' },
  };
}

function construirLog(manifesto: unknown, quantidade: number): EventLine[] {
  const linhas: EventLine[] = [];
  let ultimoElo: EventLine | null = null;
  for (let indice = 0; indice < quantidade; indice++) {
    const elo = construirElo(manifesto, ultimoElo, indice);
    linhas.push(elo);
    ultimoElo = elo;
  }
  return linhas;
}

function esperarDeduplicado(result: ResultadoChamada, seqEsperado: number): void {
  const corpo = result.structuredContent as { deduplicated: boolean; event: EventLine };
  expect(corpo.deduplicated).toBe(true);
  expect(corpo.event.seq).toBe(seqEsperado);
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

  const CASOS: { tool: string; field: string; base: Record<string, unknown> }[] = [
    {
      tool: 'registrar',
      field: 'project',
      base: {
        project: PROJ,
        process: PROC,
        id: PREFIXO_MILESTONE,
        agent: AGENTE,
        data: dadosMarco(),
      },
    },
    {
      tool: 'registrar',
      field: 'process',
      base: {
        project: PROJ,
        process: PROC,
        id: PREFIXO_MILESTONE,
        agent: AGENTE,
        data: dadosMarco(),
      },
    },
    {
      tool: 'avaliar_gate',
      field: 'project',
      base: {
        project: PROJ,
        process: PROC,
        gate: 'no-orphans',
        agent: AGENTE,
        target: 'hex:target:u1',
      },
    },
    {
      tool: 'avaliar_gate',
      field: 'process',
      base: {
        project: PROJ,
        process: PROC,
        gate: 'no-orphans',
        agent: AGENTE,
        target: 'hex:target:u1',
      },
    },
    { tool: 'estado', field: 'project', base: { project: PROJ, process: PROC } },
    { tool: 'estado', field: 'process', base: { project: PROJ, process: PROC } },
    { tool: 'eventos', field: 'project', base: { project: PROJ, process: PROC } },
    { tool: 'eventos', field: 'process', base: { project: PROJ, process: PROC } },
    { tool: 'cadeia', field: 'project', base: { project: PROJ, process: PROC } },
    { tool: 'cadeia', field: 'process', base: { project: PROJ, process: PROC } },
  ];

  for (const { tool, field, base } of CASOS) {
    for (const nomeInvalido of NOMES_INVALIDOS) {
      test(`${tool}({${field}: ${JSON.stringify(nomeInvalido)}}) → Input validation error, árvore intacta`, async () => {
        const antes = ambiente.arvore();
        const result = await ambiente.chamar(tool, { ...base, [field]: nomeInvalido });
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toMatch(/^Input validation error/);
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
        project: PROJ,
        process: 'fantasma',
        id: `${PROJ}:fantasma:milestone`,
        agent: AGENTE,
        data: dadosMarco(),
      },
    },
    {
      tool: 'avaliar_gate',
      args: {
        project: PROJ,
        process: 'fantasma',
        gate: 'no-orphans',
        agent: AGENTE,
        target: 'hex:target:u1',
      },
    },
    { tool: 'estado', args: { project: PROJ, process: 'fantasma' } },
    { tool: 'eventos', args: { project: PROJ, process: 'fantasma' } },
    { tool: 'cadeia', args: { project: PROJ, process: 'fantasma' } },
  ];

  for (const { tool, args } of CASOS) {
    test(`${tool} em processo inexistente → PROCESSO_INEXISTENTE, sem criar diretório`, async () => {
      const result = await ambiente.chamar(tool, args);
      esperarErro(result, 'PROCESS_NOT_FOUND');
      expect(fs.existsSync(path.join(ambiente.dir, PROJ, 'fantasma'))).toBe(false);
    });
  }
});

describe('M7', () => {
  test('avaliar_gate com alvo fora do formato hex:target: → Input validation error', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENTE,
      target: 'u1',
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/^Input validation error/);
  });

  test('registrar com id fora da gramática → ID_INVALIDO estruturado', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: 'lixo',
      agent: AGENTE,
      data: dadosMarco(),
    });
    const corpo = esperarErro(result, 'INVALID_ID');
    expect(corpo.detalhes[0]?.path).toBe('/id');
  });
});

describe('M8', () => {
  test('eventos pagina 250 linhas em 4 páginas (teto de caracteres), em ordem, sem exceder o teto', async () => {
    await preparar(ambiente, PROJ, PROC);
    for (let i = 0; i < 250; i++) {
      const result = await ambiente.chamar('registrar', {
        project: PROJ,
        process: PROC,
        id: PREFIXO_MILESTONE,
        agent: AGENTE,
        data: dadosMarco(),
      });
      expect(result.isError).not.toBe(true);
    }

    const paginas: { events: EventLine[]; nextCursor: number | null }[] = [];
    let cursor = 0;
    for (;;) {
      const result = await ambiente.chamar('eventos', {
        project: PROJ,
        process: PROC,
        since: cursor,
        limit: 100,
      });
      const corpo = result.structuredContent as {
        events: EventLine[];
        nextCursor: number | null;
      };
      paginas.push(corpo);
      if (isNil(corpo.nextCursor)) break;
      cursor = corpo.nextCursor;
    }

    expect(paginas).toHaveLength(4);
    const todos = paginas.flatMap((pagina) => pagina.events);
    expect(todos).toHaveLength(250);
    expect(todos.map((event) => event.seq)).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(paginas.at(-1)?.nextCursor).toBeNull();
    for (const pagina of paginas) {
      if (pagina.events.length > 1) {
        expect(JSON.stringify(pagina.events).length).toBeLessThanOrEqual(24_000);
      }
    }
  });

  test('data acima de 16 000 caracteres canônicos → EVENTO_INVALIDO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_NOTA,
      agent: AGENTE,
      data: { nota: 'x'.repeat(17_000) },
    });
    const corpo = esperarErro(result, 'INVALID_EVENT');
    expect(corpo.detalhes.some((detalhe) => detalhe.code === 'too_big')).toBe(true);
  });

  test('estado com 150 vigentes → 100 itens na lista e totais.vigentes = 150', async () => {
    await preparar(ambiente, PROJ, PROC);
    for (let i = 0; i < 150; i++) {
      const result = await ambiente.chamar('registrar', {
        project: PROJ,
        process: PROC,
        id: PREFIXO_VERDICT,
        agent: AGENTE,
        data: dadosVeredito({ target: `hex:target:u${i}`, claim: `a${i}` }),
      });
      expect(result.isError).not.toBe(true);
    }
    const result = await ambiente.chamar('estado', { project: PROJ, process: PROC });
    const corpo = result.structuredContent as {
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
    const manifesto = lerManifesto(ambiente, PROJ, PROC) as ProcessManifest;
    const corpus = gerarCorpus({
      tamanho: 300,
      manifesto,
      vocabulario: manifesto.fixed.vocabulary,
    });
    escreverCorpus(path.join(ambiente.dir, PROJ, PROC, 'events.jsonl'), corpus.texto);

    const primeira = await ambiente.chamar('eventos', {
      project: PROJ,
      process: PROC,
      search: 'webhook',
      limit: 3,
    });
    const corpoPrimeira = primeira.structuredContent as {
      events: EventLine[];
      until: number;
      nextCursor: number | null;
    };
    expect(corpoPrimeira.until).toBe(corpus.linhas.length);

    // registrado entre páginas: com `until` congelado, não deve aparecer nas páginas seguintes.
    const novo = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_VERDICT,
      agent: AGENTE,
      data: dadosVeredito({
        claim: 'novo evento sobre webhook registrado entre as páginas',
        target: 'hex:target:u1',
      }),
    });
    const idNovo = (novo.structuredContent as { event: EventLine }).event.id;

    const paginas: EventLine[] = [...corpoPrimeira.events];
    let cursor = corpoPrimeira.nextCursor;
    while (!isNil(cursor)) {
      const pagina = await ambiente.chamar('eventos', {
        project: PROJ,
        process: PROC,
        search: 'webhook',
        limit: 3,
        until: corpoPrimeira.until,
        since: cursor,
      });
      const corpo = pagina.structuredContent as { events: EventLine[]; nextCursor: number | null };
      paginas.push(...corpo.events);
      cursor = corpo.nextCursor;
    }

    const candidatos = corpus.linhas.map((linha, indice) => ({ index: indice, line: linha }));
    const { results } = runSearch(candidatos, 'webhook');
    expect(paginas.map((event) => event.id)).toEqual(
      results.map((result) => corpus.linhas[result.index].id),
    );
    expect(paginas.map((event) => event.id)).not.toContain(idNovo);

    const alem = await ambiente.chamar('eventos', {
      project: PROJ,
      process: PROC,
      until: corpus.linhas.length + 1000,
    });
    const corpoAlem = esperarErro(alem, 'INVALID_FILTER');
    expect(corpoAlem.detalhes.some((detalhe) => detalhe.path === '/until')).toBe(true);
  });

  test('h) regressão do modo cru: sem busca e sem filtros novos, a resposta é igual ao contrato anterior (M8) mais modo e ate', async () => {
    await preparar(ambiente, PROJ, PROC);
    for (let i = 0; i < 250; i++) {
      const result = await ambiente.chamar('registrar', {
        project: PROJ,
        process: PROC,
        id: PREFIXO_MILESTONE,
        agent: AGENTE,
        data: dadosMarco(),
      });
      expect(result.isError).not.toBe(true);
    }

    const paginas: {
      events: EventLine[];
      nextCursor: number | null;
      mode: string;
      until: number;
    }[] = [];
    let cursor = 0;
    for (;;) {
      const result = await ambiente.chamar('eventos', {
        project: PROJ,
        process: PROC,
        since: cursor,
        limit: 100,
      });
      const corpo = result.structuredContent as {
        events: EventLine[];
        nextCursor: number | null;
        mode: string;
        until: number;
      };
      expect(corpo.mode).toBe('raw');
      expect(corpo.until).toBe(250);
      paginas.push(corpo);
      if (isNil(corpo.nextCursor)) break;
      cursor = corpo.nextCursor;
    }

    expect(paginas).toHaveLength(4);
    const todos = paginas.flatMap((pagina) => pagina.events);
    expect(todos).toHaveLength(250);
    expect(todos.map((event) => event.seq)).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(paginas.at(-1)?.nextCursor).toBeNull();
    for (const pagina of paginas) {
      if (pagina.events.length > 1) {
        expect(JSON.stringify(pagina.events).length).toBeLessThanOrEqual(24_000);
      }
    }
  });

  test('i) linguagem natural: "problema com o webhook" cai para OR e devolve resultado não vazio', async () => {
    await preparar(ambiente, PROJ, PROC);
    const manifesto = lerManifesto(ambiente, PROJ, PROC) as ProcessManifest;
    const corpus = gerarCorpus({
      tamanho: 300,
      manifesto,
      vocabulario: manifesto.fixed.vocabulary,
    });
    escreverCorpus(path.join(ambiente.dir, PROJ, PROC, 'events.jsonl'), corpus.texto);

    const result = await ambiente.chamar('eventos', {
      project: PROJ,
      process: PROC,
      search: 'problema com o webhook',
      limit: 50,
    });
    const corpo = result.structuredContent as {
      mode: string;
      combination: string;
      events: EventLine[];
    };
    expect(corpo.mode).toBe('search');
    expect(corpo.combination).toBe('OR');
    expect(corpo.events.length).toBeGreaterThan(0);
  });
});

describe('M12', () => {
  test('b) marcoTipo fora do vocabulário → FILTRO_INVALIDO /marcoTipo sem ler o log; "gate" aceito; resultado fora do vocabulário é encontrado; sem casamento → vazio; apos ≥ antes → FILTRO_INVALIDO /apos', async () => {
    await preparar(ambiente, PROJ, PROC);
    const manifesto = lerManifesto(ambiente, PROJ, PROC) as ProcessManifest;
    const corpus = gerarCorpus({
      tamanho: 300,
      manifesto,
      vocabulario: manifesto.fixed.vocabulary,
    });
    escreverCorpus(path.join(ambiente.dir, PROJ, PROC, 'events.jsonl'), corpus.texto);

    const invalido = await ambiente.chamar('eventos', {
      project: PROJ,
      process: PROC,
      milestoneType: 'nao-existe',
    });
    const corpoErro = esperarErro(invalido, 'INVALID_FILTER');
    expect(corpoErro.detalhes.some((detalhe) => detalhe.path === '/milestoneType')).toBe(true);
    const ultimoLogDeEventos = ambiente.registros
      .filter((registro) => registro.event === 'tool' && registro.nome === 'eventos')
      .at(-1);
    expect(ultimoLogDeEventos?.candidatos).toBeUndefined();

    const comGate = await ambiente.chamar('eventos', {
      project: PROJ,
      process: PROC,
      milestoneType: 'gate',
    });
    expect(comGate.isError).not.toBe(true);

    const foraDoVocab = await ambiente.chamar('eventos', {
      project: PROJ,
      process: PROC,
      result: 'resultado-fora-do-vocabulario',
    });
    const corpoFora = foraDoVocab.structuredContent as { events: EventLine[] };
    expect(corpoFora.events.length).toBeGreaterThan(0);

    const semCasamento = await ambiente.chamar('eventos', {
      project: PROJ,
      process: PROC,
      result: 'nunca-usado-em-lugar-nenhum',
    });
    const corpoSemCasamento = semCasamento.structuredContent as { events: EventLine[] };
    expect(corpoSemCasamento.events).toEqual([]);

    const intervaloInvalido = await ambiente.chamar('eventos', {
      project: PROJ,
      process: PROC,
      after: '2026-06-01T00:00:00.000Z',
      before: '2026-01-01T00:00:00.000Z',
    });
    const corpoIntervalo = esperarErro(intervaloInvalido, 'INVALID_FILTER');
    expect(corpoIntervalo.detalhes.some((detalhe) => detalhe.path === '/after')).toBe(true);
  });

  test('e) alvo sem "hex:target:" → Input validation error', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('eventos', {
      project: PROJ,
      process: PROC,
      target: 'login',
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? '').toContain('Input validation error');
  });
});

describe('N1', () => {
  async function logDe5(): Promise<EventLine[]> {
    await preparar(ambiente, PROJ, PROC);
    const manifesto = lerManifesto(ambiente, PROJ, PROC);
    const linhas = construirLog(manifesto, 5);
    escreverLog(ambiente, PROJ, PROC, linhas);
    return linhas;
  }

  async function chamarCadeia(): Promise<Chain> {
    const result = await ambiente.chamar('cadeia', { project: PROJ, process: PROC });
    return result.structuredContent as Chain;
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

  test('(b) texto livre alterado em data da linha 1', async () => {
    const linhas = await logDe5();
    const alterada: EventLine = {
      ...linhas[1],
      data: { ...linhas[1].data, milestoneType: 'adulterado' },
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
    fs.writeFileSync(path.join(ambiente.dir, PROJ, PROC, 'events.jsonl'), texto);

    const registrado = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco(),
    });
    expect((registrado.structuredContent as { event: EventLine }).event.seq).toBe(6);

    const cadeia = await chamarCadeia();
    expect(cadeia.ok).toBe(true);
    expect(cadeia.quebras).toEqual([]);
    expect(cadeia.linhasReparadas).toEqual([5]);
  });

  test('(e) (a) + prevHash alterado na linha 4', async () => {
    const linhas = await logDe5();
    const linha4Alterada: EventLine = { ...linhas[4], prevHash: '0'.repeat(64) };
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
    fs.writeFileSync(path.join(ambiente.dir, PROJ, PROC, 'events.jsonl'), texto);

    await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco(),
    });

    const cadeia = await chamarCadeia();
    expect(cadeia.ok).toBe(true);
    expect(cadeia.linhasReparadas).toEqual([5]);
  });

  test('(g) (c) seguido de registrar legítimo → nenhuma quebra além das 2 de (c)', async () => {
    const linhas = await logDe5();
    escreverLog(ambiente, PROJ, PROC, [linhas[0], linhas[2], linhas[3], linhas[4]]);

    await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco(),
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
    const data = dadosMarco({ dueAt: '2026-09-16T18:00:00-03:00' });
    const primeiro = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data,
    });
    const corpo1 = primeiro.structuredContent as { event: EventLine };
    const antes = ambiente.arvore();

    const segundo = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: corpo1.event.id,
      agent: AGENTE,
      data,
    });
    esperarDeduplicado(segundo, corpo1.event.seq);
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('(ii) tipo custom com default omitido, reenviado omitido ou explícito → deduplicado', async () => {
    await preparar(ambiente, PROJ, PROC);
    const primeiro = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_NOTA,
      agent: AGENTE,
      data: { nota: 'x' },
    });
    const corpo1 = primeiro.structuredContent as { event: EventLine };

    const reenviadoOmitido = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: corpo1.event.id,
      agent: AGENTE,
      data: { nota: 'x' },
    });
    esperarDeduplicado(reenviadoOmitido, corpo1.event.seq);

    const reenviadoExplicito = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: corpo1.event.id,
      agent: AGENTE,
      data: { nota: 'x', prioridade: 1 },
    });
    esperarDeduplicado(reenviadoExplicito, corpo1.event.seq);
  });

  test('conteúdo diferente com o mesmo id completo → ID_CONFLITANTE', async () => {
    await preparar(ambiente, PROJ, PROC);
    const primeiro = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco(),
    });
    const corpo1 = primeiro.structuredContent as { event: EventLine };

    const conflitante = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: corpo1.event.id,
      agent: AGENTE,
      data: dadosMarco({ target: 'hex:target:outro' }),
    });
    esperarErro(conflitante, 'CONFLICTING_ID');
  });
});

describe('N4', () => {
  test('marcoTipo fora do vocabulário fixado → VOCABULARIO_VIOLADO, sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco({ milestoneType: 'desconhecido' }),
    });
    esperarErro(result, 'VOCABULARY_VIOLATED');
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('decisoes[].acao fora do vocabulário fixado → VOCABULARIO_VIOLADO, sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco({ decisions: [{ item: 'i', action: 'fora-do-vocab', text: 't' }] }),
    });
    esperarErro(result, 'VOCABULARY_VIOLATED');
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('resultado fora do vocabulário → grava e devolve aviso VOCABULARIO_DESCONHECIDO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_VERDICT,
      agent: AGENTE,
      data: dadosVeredito({ result: 'desconhecido' }),
    });
    expect(result.isError).not.toBe(true);
    const corpo = result.structuredContent as { warnings: { codigo: string }[] };
    expect(corpo.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ codigo: 'UNKNOWN_VOCABULARY' })]),
    );
  });
});

describe('N5', () => {
  test('sem-orfaos: estado limpo passa, Marco vencido reprova com prova', async () => {
    await preparar(ambiente, PROJ, PROC);
    const limpo = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENTE,
      target: 'hex:target:u1',
    });
    const corpoLimpo = limpo.structuredContent as { passed: boolean; evidence: unknown[] };
    expect(corpoLimpo.passed).toBe(true);
    expect(corpoLimpo.evidence).toEqual([]);

    ambiente.definirRelogio(new Date('2026-06-01T00:00:00.000Z'));
    await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco({ target: 'hex:target:u2', dueAt: '2026-01-01T00:00:00.000Z' }),
    });

    const violado = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENTE,
      target: 'hex:target:u2',
    });
    const corpoViolado = violado.structuredContent as { passed: boolean; evidence: unknown[] };
    expect(corpoViolado.passed).toBe(false);
    expect(corpoViolado.evidence.length).toBeGreaterThan(0);
  });

  test('cadeia-integra passa num log íntegro', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'chain-intact',
      agent: AGENTE,
      target: 'hex:target:u1',
    });
    expect((result.structuredContent as { passed: boolean }).passed).toBe(true);
  });
});

describe('N6', () => {
  test('gate custom sem resultado → AVALIACAO_INVALIDA', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'gate-custom',
      agent: AGENTE,
      target: 'hex:target:u1',
    });
    esperarErro(result, 'INVALID_EVALUATION');
  });

  test('gate embutido com resultado informado → AVALIACAO_INVALIDA', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENTE,
      target: 'hex:target:u1',
      result: { passed: true, evidence: 'ok' },
    });
    esperarErro(result, 'INVALID_EVALUATION');
  });

  test('gate não fixado, nem embutido nem no snapshot → GATE_NAO_REGISTRADO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'fantasma',
      agent: AGENTE,
      target: 'hex:target:u1',
      result: { passed: true, evidence: 'ok' },
    });
    esperarErro(result, 'GATE_NOT_REGISTERED');
  });

  test('gate registrado depois de criar_processo → GATE_NAO_REGISTRADO', async () => {
    await preparar(ambiente, PROJ, PROC);
    await ambiente.chamar('registrar_gate', {
      project: PROJ,
      name: 'gate-tardio',
      criteria: 'critério tardio',
    });
    const result = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'gate-tardio',
      agent: AGENTE,
      target: 'hex:target:u1',
      result: { passed: true, evidence: 'ok' },
    });
    esperarErro(result, 'GATE_NOT_REGISTERED');
  });

  test('gate custom aceito → Marco de gate com criterio do snapshot e origem custom', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'gate-custom',
      agent: AGENTE,
      target: 'hex:target:u1',
      result: { passed: false, evidence: ['evidência'] },
    });
    expect(result.isError).not.toBe(true);
    const corpo = result.structuredContent as { event: EventLine };
    const data = corpo.event.data as {
      milestoneType: string;
      gate: { name: string; origin: string; criteria: string; passed: boolean };
    };
    expect(data.milestoneType).toBe('gate');
    expect(data.gate.origin).toBe('custom');
    expect(data.gate.criteria).toBe('critério custom qualquer');
    expect(data.gate.passed).toBe(false);
  });
});

describe('N8', () => {
  test('timestamp termina em Z; prazoExecucao com offset é normalizado para UTC', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco({ dueAt: '2026-09-16T18:00:00-03:00' }),
    });
    const corpo = result.structuredContent as { event: EventLine };
    expect(corpo.event.timestamp).toMatch(/Z$/);
    expect((corpo.event.data as { dueAt: string }).dueAt).toBe('2026-09-16T21:00:00.000Z');
  });
});

describe('N9', () => {
  test('prefixo gera id no formato projeto:processo:tipo:uuidv7', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco(),
    });
    const corpo = result.structuredContent as { event: EventLine };
    expect(corpo.event.id).toMatch(new RegExp(`^${PROJ}:${PROC}:milestone:[0-9a-f-]{36}$`));
  });

  test('projeto/processo do id divergente dos parâmetros → ID_INVALIDO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: `outro-project:${PROC}:milestone`,
      agent: AGENTE,
      data: dadosMarco(),
    });
    esperarErro(result, 'INVALID_ID');
  });

  test('tipo não fixado no processo → TIPO_NAO_FIXADO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: `${PROJ}:${PROC}:fantasma`,
      agent: AGENTE,
      data: { x: 1 },
    });
    esperarErro(result, 'TYPE_NOT_PINNED');
  });

  test('id completo inexistente → ID_DESCONHECIDO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: `${PREFIXO_MILESTONE}:${randomUUIDv7()}`,
      agent: AGENTE,
      data: dadosMarco(),
    });
    esperarErro(result, 'UNKNOWN_ID');
  });
});

describe('N12', () => {
  test.each(['u1', 'hex:target:', 'hex:target:a:b', 'hex:target:a b', 'hex:outro:x'])(
    'alvo %s inválido em Marco → EVENTO_INVALIDO em /data/alvo, sem linha',
    async (alvoInvalido) => {
      await preparar(ambiente, PROJ, PROC);
      const antes = ambiente.arvore();
      const result = await ambiente.chamar('registrar', {
        project: PROJ,
        process: PROC,
        id: PREFIXO_MILESTONE,
        agent: AGENTE,
        data: dadosMarco({ target: alvoInvalido }),
      });
      const corpo = esperarErro(result, 'INVALID_EVENT');
      expect(corpo.detalhes).toContainEqual(expect.objectContaining({ path: '/data/target' }));
      expect(ambiente.arvore()).toEqual(antes);
    },
  );

  test('destino inválido em Veredito → EVENTO_INVALIDO em /data/destino', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_VERDICT,
      agent: AGENTE,
      data: dadosVeredito({ target: 'hex:outro:x' }),
    });
    const corpo = esperarErro(result, 'INVALID_EVENT');
    expect(corpo.detalhes).toContainEqual(expect.objectContaining({ path: '/data/target' }));
  });

  test('hex:target:u1 é aceito', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco(),
    });
    expect(result.isError).not.toBe(true);
  });

  test('avaliar_gate com alvo: "u1" → Input validation error, sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const result = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENTE,
      target: 'u1',
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/^Input validation error/);
    expect(ambiente.arvore()).toEqual(antes);
  });
});

describe('N13', () => {
  test('Marco vencido gera órfão; avaliar_gate não o remove de estado.orfaos', async () => {
    await preparar(ambiente, PROJ, PROC);
    ambiente.definirRelogio(new Date('2026-06-01T00:00:00.000Z'));
    await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco({ target: 'hex:target:x', dueAt: '2026-01-01T00:00:00.000Z' }),
    });

    const antes = await ambiente.chamar('estado', {
      project: PROJ,
      process: PROC,
      sections: ['orfaos'],
    });
    expect((antes.structuredContent as { orfaos: unknown[] }).orfaos).toHaveLength(1);

    const avaliado = await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENTE,
      target: 'hex:target:x',
    });
    expect((avaliado.structuredContent as { passed: boolean }).passed).toBe(false);

    const depois = await ambiente.chamar('estado', {
      project: PROJ,
      process: PROC,
      sections: ['orfaos'],
    });
    expect((depois.structuredContent as { orfaos: unknown[] }).orfaos).toHaveLength(1);
  });

  test('Marco de gate sozinho num alvo não cria abertura', async () => {
    await preparar(ambiente, PROJ, PROC);
    await ambiente.chamar('avaliar_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENTE,
      target: 'hex:target:y',
    });

    ambiente.definirRelogio(new Date('2099-01-01T00:00:00.000Z'));
    const result = await ambiente.chamar('estado', {
      project: PROJ,
      process: PROC,
      sections: ['orfaos'],
    });
    const orfaos = (result.structuredContent as { orfaos: { target: string }[] }).orfaos;
    expect(orfaos.some((orfao) => orfao.target === 'hex:target:y')).toBe(false);
  });
});

describe('N14', () => {
  test('prevHash do 1º elo é a âncora de process.json', async () => {
    await preparar(ambiente, PROJ, PROC);
    const registrado = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco(),
    });
    const event = (registrado.structuredContent as { event: EventLine }).event;
    expect(event.prevHash).toBe(anchor(lerManifesto(ambiente, PROJ, PROC)));
  });

  test('fixado alterado com hashes recalculados → cadeia.quebras inclui {0, hash-nao-bate}', async () => {
    await preparar(ambiente, PROJ, PROC);
    await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco(),
    });

    const caminhoManifesto = path.join(ambiente.dir, PROJ, PROC, 'process.json');
    const manifesto = JSON.parse(fs.readFileSync(caminhoManifesto, 'utf8')) as {
      fixed: { vocabulary: { core: { milestoneType: string[] } } };
      hashes: { schemas: string; vocabulario: string; gates: string };
    };
    manifesto.fixed.vocabulary.core.milestoneType.push('outro-value');
    manifesto.hashes.vocabulario = sha256hex(canonicalize(manifesto.fixed.vocabulary) ?? '');
    fs.writeFileSync(caminhoManifesto, JSON.stringify(manifesto, null, 2));

    const cadeia = (await ambiente.chamar('cadeia', { project: PROJ, process: PROC }))
      .structuredContent as Chain;
    expect(cadeia.quebras).toEqual(
      expect.arrayContaining([{ indice: 0, motivo: 'hash-nao-bate' }]),
    );
  });
});

describe('S2', () => {
  test('evento custom válido vira elo', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_NOTA,
      agent: AGENTE,
      data: { nota: 'ok', categoria: 'a' },
    });
    expect(result.isError).not.toBe(true);
  });

  test('chave extra → EVENTO_INVALIDO em /data/..., sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_NOTA,
      agent: AGENTE,
      data: { nota: 'ok', extra: 1 },
    });
    const corpo = esperarErro(result, 'INVALID_EVENT');
    expect(corpo.detalhes[0]?.path.startsWith('/data')).toBe(true);
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('enum inválido → EVENTO_INVALIDO em /data/categoria', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_NOTA,
      agent: AGENTE,
      data: { nota: 'ok', categoria: 'fora' },
    });
    const corpo = esperarErro(result, 'INVALID_EVENT');
    expect(corpo.detalhes).toContainEqual(expect.objectContaining({ path: '/data/categoria' }));
  });

  test('format date-time inválido → EVENTO_INVALIDO em /data/quando', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_NOTA,
      agent: AGENTE,
      data: { nota: 'ok', quando: 'not-a-date' },
    });
    const corpo = esperarErro(result, 'INVALID_EVENT');
    expect(corpo.detalhes).toContainEqual(expect.objectContaining({ path: '/data/quando' }));
  });
});

describe('S3', () => {
  test('eventos custom aparecem em eventos e ficam inertes na projeção do Estado', async () => {
    await preparar(ambiente, PROJ, PROC);

    await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: dadosMarco({ target: 'hex:target:a', dueAt: '2025-01-01T00:00:00.000Z' }),
    });
    await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_NOTA,
      agent: AGENTE,
      data: { nota: 'intercalado' },
    });
    await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_VERDICT,
      agent: AGENTE,
      data: dadosVeredito({ target: 'hex:target:a', claim: 'a1' }),
    });

    const eventosResult = (await ambiente.chamar('eventos', { project: PROJ, process: PROC }))
      .structuredContent as { events: EventLine[] };
    expect(eventosResult.events.map((event) => event.type)).toEqual([
      'milestone',
      'nota',
      'verdict',
    ]);

    const estado = (await ambiente.chamar('estado', { project: PROJ, process: PROC }))
      .structuredContent as {
      vigentes: unknown[];
      orfaos: unknown[];
      conflitos: unknown[];
      aRevisar: unknown[];
      referenciasInvalidas: unknown[];
    };
    // o Veredito fecha o ciclo do Marco: sem o custom intercalado no meio, o result seria idêntico.
    expect(estado.vigentes).toHaveLength(1);
    expect(estado.orfaos).toEqual([]);
    expect(estado.conflitos).toEqual([]);
    expect(estado.aRevisar).toEqual([]);
    expect(estado.referenciasInvalidas).toEqual([]);
  });
});

describe('S5', () => {
  test('schema, vocabulário e gate alterados entre a criação de dois processos: cada um usa sua versão', async () => {
    const project = 'p-s5';
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
      project,
      owner: 'core',
      milestoneType: ['v1'],
      result: [],
      action: [],
    });
    await ambiente.chamar('registrar_tipo', { project, name: 'nota', schema: schemaAntigo });
    await ambiente.chamar('registrar_gate', { project, name: 'g', criteria: 'v1' });
    await ambiente.chamar('criar_processo', { project, process: 'proc-antigo' });

    await ambiente.chamar('registrar_vocabulario', {
      project,
      owner: 'core',
      milestoneType: ['v2'],
      result: [],
      action: [],
    });
    await ambiente.chamar('registrar_tipo', { project, name: 'nota', schema: schemaNovo });
    await ambiente.chamar('registrar_gate', { project, name: 'g', criteria: 'v2' });
    await ambiente.chamar('criar_processo', { project, process: 'proc-novo' });

    const antigoV1 = await ambiente.chamar('registrar', {
      project,
      process: 'proc-antigo',
      id: `${project}:proc-antigo:milestone`,
      agent: AGENTE,
      data: { milestoneType: 'v1', target: 'hex:target:u1' },
    });
    expect(antigoV1.isError).not.toBe(true);

    const antigoV2 = await ambiente.chamar('registrar', {
      project,
      process: 'proc-antigo',
      id: `${project}:proc-antigo:milestone`,
      agent: AGENTE,
      data: { milestoneType: 'v2', target: 'hex:target:u1' },
    });
    esperarErro(antigoV2, 'VOCABULARY_VIOLATED');

    const novoV2 = await ambiente.chamar('registrar', {
      project,
      process: 'proc-novo',
      id: `${project}:proc-novo:milestone`,
      agent: AGENTE,
      data: { milestoneType: 'v2', target: 'hex:target:u1' },
    });
    expect(novoV2.isError).not.toBe(true);

    const novoExtra = await ambiente.chamar('registrar', {
      project,
      process: 'proc-novo',
      id: `${project}:proc-novo:nota`,
      agent: AGENTE,
      data: { nota: 'x', extra: 'y' },
    });
    expect(novoExtra.isError).not.toBe(true);

    const antigoExtra = await ambiente.chamar('registrar', {
      project,
      process: 'proc-antigo',
      id: `${project}:proc-antigo:nota`,
      agent: AGENTE,
      data: { nota: 'x', extra: 'y' },
    });
    esperarErro(antigoExtra, 'INVALID_EVENT');

    const gateAntigo = (
      await ambiente.chamar('avaliar_gate', {
        project,
        process: 'proc-antigo',
        gate: 'g',
        agent: AGENTE,
        target: 'hex:target:u1',
        result: { passed: true, evidence: 'ok' },
      })
    ).structuredContent as { event: EventLine };
    expect((gateAntigo.event.data as { gate: { criteria: string } }).gate.criteria).toBe('v1');

    const gateNovo = (
      await ambiente.chamar('avaliar_gate', {
        project,
        process: 'proc-novo',
        gate: 'g',
        agent: AGENTE,
        target: 'hex:target:u1',
        result: { passed: true, evidence: 'ok' },
      })
    ).structuredContent as { event: EventLine };
    expect((gateNovo.event.data as { gate: { criteria: string } }).gate.criteria).toBe('v2');
  });
});

describe('RESERVED_FIELD', () => {
  test('Marco com marcoTipo "gate" → CAMPO_RESERVADO, sem linha', async () => {
    await preparar(ambiente, PROJ, PROC);
    const antes = ambiente.arvore();
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: { milestoneType: 'gate', target: 'hex:target:u1', gate: { name: 'x' } },
    });
    esperarErro(result, 'RESERVED_FIELD');
    expect(ambiente.arvore()).toEqual(antes);
  });

  test('Marco com chave "gate", mesmo sem marcoTipo "gate" → CAMPO_RESERVADO', async () => {
    await preparar(ambiente, PROJ, PROC);
    const result = await ambiente.chamar('registrar', {
      project: PROJ,
      process: PROC,
      id: PREFIXO_MILESTONE,
      agent: AGENTE,
      data: { milestoneType: 'aprovado', target: 'hex:target:u1', gate: 'qualquer' },
    });
    esperarErro(result, 'RESERVED_FIELD');
  });
});
