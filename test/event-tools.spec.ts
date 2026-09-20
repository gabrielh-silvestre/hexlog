import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import canonicalize from 'canonicalize';
import { isNil, range } from 'es-toolkit';
import { search as runSearch } from '../src/search.ts';
import { anchor, expectedPrevHash, nextSeq, sha256hex, type Chain } from '../src/chain.ts';
import type { ProcessManifest } from '../src/definitions.ts';
import type { EventLine } from '../src/events.ts';
import { writeCorpus, generateCorpus } from './fixtures/corpus.ts';
import { type Environment, createEnvironment, expectError, registerCore } from './helpers.ts';

type CallResult = Awaited<ReturnType<Environment['call']>>;

const PROJ = 'p1';
const PROC = 'proc1';
const AGENT = 'agent-test';
const MILESTONE_PREFIX = `${PROJ}:${PROC}:milestone`;
const VERDICT_PREFIX = `${PROJ}:${PROC}:verdict`;
const NOTE_PREFIX = `${PROJ}:${PROC}:note`;

const SCHEMA_CUSTOM = {
  type: 'object',
  properties: {
    note: { type: 'string' },
    priority: { type: 'number', default: 1 },
    when: { type: 'string', format: 'date-time' },
    category: { type: 'string', enum: ['a', 'b'] },
  },
  required: ['note'],
  additionalProperties: false,
};

function milestoneData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { milestoneType: 'approved', target: 'hex:target:u1', ...overrides };
}

function verdictData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
async function prepare(environment: Environment, project: string, process: string): Promise<void> {
  await registerCore(environment, project);
  await environment.call('register_type', { project, name: 'note', schema: SCHEMA_CUSTOM });
  await environment.call('register_gate', {
    project,
    name: 'gate-custom',
    criteria: 'any custom criteria',
  });
  await environment.call('create_process', { project, process });
}

function readManifest(environment: Environment, project: string, process: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(environment.dir, project, process, 'process.json'), 'utf8'),
  );
}

function writeLog(
  environment: Environment,
  project: string,
  process: string,
  lines: (EventLine | string)[],
): void {
  const text =
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n';
  fs.writeFileSync(path.join(environment.dir, project, process, 'events.jsonl'), text);
}

function buildLink(manifest: unknown, lastLink: EventLine | null, index: number): EventLine {
  return {
    seq: nextSeq(lastLink, 0),
    id: `${PROJ}:${PROC}:milestone:${randomUUIDv7()}`,
    type: 'milestone',
    timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    agent: AGENT,
    prevHash: expectedPrevHash(lastLink, manifest),
    data: { milestoneType: 'approved', target: 'hex:target:u1' },
  };
}

function buildLog(manifest: unknown, count: number): EventLine[] {
  const lines: EventLine[] = [];
  let lastLink: EventLine | null = null;
  for (let index = 0; index < count; index++) {
    const link = buildLink(manifest, lastLink, index);
    lines.push(link);
    lastLink = link;
  }
  return lines;
}

function expectDeduplicated(result: CallResult, expectedSeq: number): void {
  const body = result.structuredContent as { deduplicated: boolean; event: EventLine };
  expect(body.deduplicated).toBe(true);
  expect(body.event.seq).toBe(expectedSeq);
}

let environment: Environment;

beforeEach(async () => {
  environment = await createEnvironment();
});

afterEach(async () => {
  await environment.close();
});

describe('M1', () => {
  test('tools/list expõe as 10 tools, cada uma com inputSchema e outputSchema', async () => {
    const { tools } = await environment.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'evaluate_gate',
        'chain',
        'create_process',
        'state',
        'events',
        'list',
        'register',
        'register_gate',
        'register_type',
        'register_vocabulary',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });
});

describe('M2', () => {
  const INVALID_NAMES = ['..', 'a/b', 'A', '', '-a', 'a'.repeat(64)];

  const CASES: { tool: string; field: string; base: Record<string, unknown> }[] = [
    {
      tool: 'register',
      field: 'project',
      base: {
        project: PROJ,
        process: PROC,
        id: MILESTONE_PREFIX,
        agent: AGENT,
        data: milestoneData(),
      },
    },
    {
      tool: 'register',
      field: 'process',
      base: {
        project: PROJ,
        process: PROC,
        id: MILESTONE_PREFIX,
        agent: AGENT,
        data: milestoneData(),
      },
    },
    {
      tool: 'evaluate_gate',
      field: 'project',
      base: {
        project: PROJ,
        process: PROC,
        gate: 'no-orphans',
        agent: AGENT,
        target: 'hex:target:u1',
      },
    },
    {
      tool: 'evaluate_gate',
      field: 'process',
      base: {
        project: PROJ,
        process: PROC,
        gate: 'no-orphans',
        agent: AGENT,
        target: 'hex:target:u1',
      },
    },
    { tool: 'state', field: 'project', base: { project: PROJ, process: PROC } },
    { tool: 'state', field: 'process', base: { project: PROJ, process: PROC } },
    { tool: 'events', field: 'project', base: { project: PROJ, process: PROC } },
    { tool: 'events', field: 'process', base: { project: PROJ, process: PROC } },
    { tool: 'chain', field: 'project', base: { project: PROJ, process: PROC } },
    { tool: 'chain', field: 'process', base: { project: PROJ, process: PROC } },
  ];

  for (const { tool, field, base } of CASES) {
    for (const invalidName of INVALID_NAMES) {
      test(`${tool}({${field}: ${JSON.stringify(invalidName)}}) → Input validation error, árvore intacta`, async () => {
        const before = environment.tree();
        const result = await environment.call(tool, { ...base, [field]: invalidName });
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toMatch(/^Input validation error/);
        expect(environment.tree()).toEqual(before);
      });
    }
  }
});

describe('M3', () => {
  const CASES: { tool: string; args: Record<string, unknown> }[] = [
    {
      tool: 'register',
      args: {
        project: PROJ,
        process: 'ghost',
        id: `${PROJ}:ghost:milestone`,
        agent: AGENT,
        data: milestoneData(),
      },
    },
    {
      tool: 'evaluate_gate',
      args: {
        project: PROJ,
        process: 'ghost',
        gate: 'no-orphans',
        agent: AGENT,
        target: 'hex:target:u1',
      },
    },
    { tool: 'state', args: { project: PROJ, process: 'ghost' } },
    { tool: 'events', args: { project: PROJ, process: 'ghost' } },
    { tool: 'chain', args: { project: PROJ, process: 'ghost' } },
  ];

  for (const { tool, args } of CASES) {
    test(`${tool} em processo inexistente → PROCESS_NOT_FOUND, sem criar diretório`, async () => {
      const result = await environment.call(tool, args);
      expectError(result, 'PROCESS_NOT_FOUND');
      expect(fs.existsSync(path.join(environment.dir, PROJ, 'ghost'))).toBe(false);
    });
  }
});

describe('M7', () => {
  test('evaluate_gate com target fora do formato hex:target: → Input validation error', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENT,
      target: 'u1',
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/^Input validation error/);
  });

  test('registrar com id fora da gramática → ID_INVALIDO estruturado', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: 'garbage',
      agent: AGENT,
      data: milestoneData(),
    });
    const body = expectError(result, 'INVALID_ID');
    expect(body.details[0]?.path).toBe('/id');
  });
});

describe('M8', () => {
  test('eventos pagina 250 linhas em 4 páginas (teto de caracteres), em ordem, sem exceder o teto', async () => {
    await prepare(environment, PROJ, PROC);
    for (let i = 0; i < 250; i++) {
      const result = await environment.call('register', {
        project: PROJ,
        process: PROC,
        id: MILESTONE_PREFIX,
        agent: AGENT,
        data: milestoneData(),
      });
      expect(result.isError).not.toBe(true);
    }

    const pages: { events: EventLine[]; nextCursor: number | null }[] = [];
    let cursor = 0;
    for (;;) {
      const result = await environment.call('events', {
        project: PROJ,
        process: PROC,
        since: cursor,
        limit: 100,
      });
      const body = result.structuredContent as {
        events: EventLine[];
        nextCursor: number | null;
      };
      pages.push(body);
      if (isNil(body.nextCursor)) break;
      cursor = body.nextCursor;
    }

    expect(pages).toHaveLength(4);
    const all = pages.flatMap((page) => page.events);
    expect(all).toHaveLength(250);
    expect(all.map((event) => event.seq)).toEqual(range(250));
    expect(pages.at(-1)?.nextCursor).toBeNull();
    for (const page of pages) {
      if (page.events.length > 1) {
        expect(JSON.stringify(page.events).length).toBeLessThanOrEqual(24_000);
      }
    }
  });

  test('data acima de 16 000 caracteres canônicos → EVENTO_INVALIDO', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: NOTE_PREFIX,
      agent: AGENT,
      data: { note: 'x'.repeat(17_000) },
    });
    const body = expectError(result, 'INVALID_EVENT');
    expect(body.details.some((detail) => detail.code === 'too_big')).toBe(true);
  });

  test('state com 150 active → 100 itens na lista e totals.active = 150', async () => {
    await prepare(environment, PROJ, PROC);
    for (let i = 0; i < 150; i++) {
      const result = await environment.call('register', {
        project: PROJ,
        process: PROC,
        id: VERDICT_PREFIX,
        agent: AGENT,
        data: verdictData({ target: `hex:target:u${i}`, claim: `a${i}` }),
      });
      expect(result.isError).not.toBe(true);
    }
    const result = await environment.call('state', { project: PROJ, process: PROC });
    const body = result.structuredContent as {
      active: unknown[];
      targets: string[];
      totals: Record<string, number>;
    };
    expect(body.active).toHaveLength(100);
    expect(body.totals.active).toBe(150);
    expect(body.targets).toHaveLength(100);
    expect(body.totals.targets).toBe(150);
  });
});

describe('P4', () => {
  test('withData traz o data do Verdict vigente em cada item active', async () => {
    await prepare(environment, PROJ, PROC);
    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ claim: 'a' }),
    });

    const result = await environment.call('state', {
      project: PROJ,
      process: PROC,
      sections: ['active'],
      withData: true,
    });
    const body = result.structuredContent as { active: { data?: Record<string, unknown> }[] };
    expect(body.active[0]?.data).toMatchObject({ claim: 'a' });
  });

  test('withData acima de PAGE_CHARS_CAP (24k) → itens excedentes vêm sem data e com truncated: true', async () => {
    await prepare(environment, PROJ, PROC);
    const bigEvidence = 'x'.repeat(3900);
    for (let i = 0; i < 8; i++) {
      const result = await environment.call('register', {
        project: PROJ,
        process: PROC,
        id: VERDICT_PREFIX,
        agent: AGENT,
        data: verdictData({ claim: `a${i}`, target: `hex:target:u${i}`, evidence: bigEvidence }),
      });
      expect(result.isError).not.toBe(true);
    }

    const result = await environment.call('state', {
      project: PROJ,
      process: PROC,
      sections: ['active'],
      withData: true,
    });
    const body = result.structuredContent as {
      active: { data?: unknown; truncated?: boolean }[];
    };
    expect(body.active.some((item) => item.truncated === true)).toBe(true);
    expect(body.active.some((item) => item.data !== undefined)).toBe(true);
    for (const item of body.active) {
      if (item.truncated === true) expect(item.data).toBeUndefined();
    }
  });

  test('withData: itens conflict contam no PAGE_CHARS_CAP e recebem truncated: true, nunca data', async () => {
    await prepare(environment, PROJ, PROC);
    const bigClaim = (i: number) => `${i}`.padEnd(3900, 'x');
    for (let i = 0; i < 8; i++) {
      for (const source of ['f1', 'f2']) {
        const result = await environment.call('register', {
          project: PROJ,
          process: PROC,
          id: VERDICT_PREFIX,
          agent: AGENT,
          data: verdictData({ claim: bigClaim(i), target: `hex:target:u${i}`, source }),
        });
        expect(result.isError).not.toBe(true);
      }
    }

    const result = await environment.call('state', {
      project: PROJ,
      process: PROC,
      sections: ['active'],
      withData: true,
    });
    const body = result.structuredContent as {
      active: { status: string; data?: unknown; truncated?: boolean }[];
    };
    expect(body.active.every((item) => item.status === 'conflict')).toBe(true);
    expect(body.active.some((item) => item.truncated === true)).toBe(true);
    expect(body.active.every((item) => item.data === undefined)).toBe(true);
  });

  test('targets inclui target totalmente superado', async () => {
    await prepare(environment, PROJ, PROC);
    const v1 = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ claim: 'a', target: 'hex:target:gone' }),
    });
    const v1Id = (v1.structuredContent as { event: EventLine }).event.id;
    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ claim: 'a', target: 'hex:target:elsewhere', supersedes: [v1Id] }),
    });

    const result = await environment.call('state', { project: PROJ, process: PROC });
    const body = result.structuredContent as {
      targets: string[];
      active: { target: string }[];
    };
    expect(body.targets).toEqual(
      expect.arrayContaining(['hex:target:elsewhere', 'hex:target:gone']),
    );
    expect(body.active.some((item) => item.target === 'hex:target:gone')).toBe(false);
  });
});

describe('M9', () => {
  test('annotations das 5 tools de eventos batem com §4.12', async () => {
    const { tools } = await environment.client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));

    for (const name of ['register', 'evaluate_gate']) {
      expect(byName[name]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    for (const name of ['state', 'events', 'chain']) {
      expect(byName[name]).toMatchObject({
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
    await prepare(environment, PROJ, PROC);
    const manifest = readManifest(environment, PROJ, PROC) as ProcessManifest;
    const corpus = generateCorpus({
      size: 300,
      manifest,
      vocabulary: manifest.fixed.vocabulary,
    });
    writeCorpus(path.join(environment.dir, PROJ, PROC, 'events.jsonl'), corpus.text);

    const firstResult = await environment.call('events', {
      project: PROJ,
      process: PROC,
      search: 'webhook',
      limit: 3,
    });
    const firstBody = firstResult.structuredContent as {
      events: EventLine[];
      until: number;
      nextCursor: number | null;
    };
    expect(firstBody.until).toBe(corpus.lines.length);

    // registrado entre páginas: com `until` congelado, não deve aparecer nas páginas seguintes.
    const newRegistration = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({
        claim: 'new event about webhook registered between pages',
        target: 'hex:target:u1',
      }),
    });
    const newId = (newRegistration.structuredContent as { event: EventLine }).event.id;

    const pages: EventLine[] = [...firstBody.events];
    let cursor = firstBody.nextCursor;
    while (!isNil(cursor)) {
      const page = await environment.call('events', {
        project: PROJ,
        process: PROC,
        search: 'webhook',
        limit: 3,
        until: firstBody.until,
        since: cursor,
      });
      const body = page.structuredContent as { events: EventLine[]; nextCursor: number | null };
      pages.push(...body.events);
      cursor = body.nextCursor;
    }

    const candidates = corpus.lines.map((line, index) => ({ index, line }));
    const { results } = runSearch(candidates, 'webhook');
    expect(pages.map((event) => event.id)).toEqual(
      results.map((result) => corpus.lines[result.index].id),
    );
    expect(pages.map((event) => event.id)).not.toContain(newId);

    const beyondResult = await environment.call('events', {
      project: PROJ,
      process: PROC,
      until: corpus.lines.length + 1000,
    });
    const beyondBody = expectError(beyondResult, 'INVALID_FILTER');
    expect(beyondBody.details.some((detail) => detail.path === '/until')).toBe(true);
  });

  test('h) regressão do modo cru: sem busca e sem filtros novos, a resposta é igual ao contrato anterior (M8) mais modo e ate', async () => {
    await prepare(environment, PROJ, PROC);
    for (let i = 0; i < 250; i++) {
      const result = await environment.call('register', {
        project: PROJ,
        process: PROC,
        id: MILESTONE_PREFIX,
        agent: AGENT,
        data: milestoneData(),
      });
      expect(result.isError).not.toBe(true);
    }

    const pages: {
      events: EventLine[];
      nextCursor: number | null;
      mode: string;
      until: number;
    }[] = [];
    let cursor = 0;
    for (;;) {
      const result = await environment.call('events', {
        project: PROJ,
        process: PROC,
        since: cursor,
        limit: 100,
      });
      const body = result.structuredContent as {
        events: EventLine[];
        nextCursor: number | null;
        mode: string;
        until: number;
      };
      expect(body.mode).toBe('raw');
      expect(body.until).toBe(250);
      pages.push(body);
      if (isNil(body.nextCursor)) break;
      cursor = body.nextCursor;
    }

    expect(pages).toHaveLength(4);
    const all = pages.flatMap((page) => page.events);
    expect(all).toHaveLength(250);
    expect(all.map((event) => event.seq)).toEqual(range(250));
    expect(pages.at(-1)?.nextCursor).toBeNull();
    for (const page of pages) {
      if (page.events.length > 1) {
        expect(JSON.stringify(page.events).length).toBeLessThanOrEqual(24_000);
      }
    }
  });

  test('i) linguagem natural: "problema com o webhook" cai para OR e devolve resultado não vazio', async () => {
    await prepare(environment, PROJ, PROC);
    const manifest = readManifest(environment, PROJ, PROC) as ProcessManifest;
    const corpus = generateCorpus({
      size: 300,
      manifest,
      vocabulary: manifest.fixed.vocabulary,
    });
    writeCorpus(path.join(environment.dir, PROJ, PROC, 'events.jsonl'), corpus.text);

    const result = await environment.call('events', {
      project: PROJ,
      process: PROC,
      search: 'problem with the webhook',
      limit: 50,
    });
    const body = result.structuredContent as {
      mode: string;
      combination: string;
      events: EventLine[];
    };
    expect(body.mode).toBe('search');
    expect(body.combination).toBe('OR');
    expect(body.events.length).toBeGreaterThan(0);
  });
});

describe('M12', () => {
  test('b) milestoneType fora do vocabulário → INVALID_FILTER /milestoneType sem ler o log; "gate" aceito; resultado fora do vocabulário é encontrado; sem casamento → vazio; after ≥ before → INVALID_FILTER /after', async () => {
    await prepare(environment, PROJ, PROC);
    const manifest = readManifest(environment, PROJ, PROC) as ProcessManifest;
    const corpus = generateCorpus({
      size: 300,
      manifest,
      vocabulary: manifest.fixed.vocabulary,
    });
    writeCorpus(path.join(environment.dir, PROJ, PROC, 'events.jsonl'), corpus.text);

    const invalidResult = await environment.call('events', {
      project: PROJ,
      process: PROC,
      milestoneType: 'does-not-exist',
    });
    const errorBody = expectError(invalidResult, 'INVALID_FILTER');
    expect(errorBody.details.some((detail) => detail.path === '/milestoneType')).toBe(true);
    const lastEventsLog = environment.records
      .filter((record) => record.event === 'tool' && record.name === 'events')
      .at(-1);
    expect(lastEventsLog?.candidates).toBeUndefined();

    const withGateResult = await environment.call('events', {
      project: PROJ,
      process: PROC,
      milestoneType: 'gate',
    });
    expect(withGateResult.isError).not.toBe(true);

    const outsideVocabularyResult = await environment.call('events', {
      project: PROJ,
      process: PROC,
      result: 'result-outside-vocabulary',
    });
    const outsideBody = outsideVocabularyResult.structuredContent as { events: EventLine[] };
    expect(outsideBody.events.length).toBeGreaterThan(0);

    const noMatchResult = await environment.call('events', {
      project: PROJ,
      process: PROC,
      result: 'never-used-anywhere',
    });
    const noMatchBody = noMatchResult.structuredContent as { events: EventLine[] };
    expect(noMatchBody.events).toEqual([]);

    const invalidRangeResult = await environment.call('events', {
      project: PROJ,
      process: PROC,
      after: '2026-06-01T00:00:00.000Z',
      before: '2026-01-01T00:00:00.000Z',
    });
    const invalidRangeBody = expectError(invalidRangeResult, 'INVALID_FILTER');
    expect(invalidRangeBody.details.some((detail) => detail.path === '/after')).toBe(true);
  });

  test('e) target sem "hex:target:" → Input validation error', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('events', {
      project: PROJ,
      process: PROC,
      target: 'login',
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? '').toContain('Input validation error');
  });
});

describe('N1', () => {
  async function logOfFive(): Promise<EventLine[]> {
    await prepare(environment, PROJ, PROC);
    const manifest = readManifest(environment, PROJ, PROC);
    const lines = buildLog(manifest, 5);
    writeLog(environment, PROJ, PROC, lines);
    return lines;
  }

  async function callChain(): Promise<Chain> {
    const result = await environment.call('chain', { project: PROJ, process: PROC });
    return result.structuredContent as Chain;
  }

  test('(a) JSON inválido na linha 1', async () => {
    const lines = await logOfFive();
    writeLog(environment, PROJ, PROC, [lines[0], '{ broken json', lines[2], lines[3], lines[4]]);
    const chain = await callChain();
    expect(chain.totalBreaks).toBe(2);
    expect(chain.breaks).toEqual(
      expect.arrayContaining([
        { index: 1, reason: 'invalid-line' },
        { index: 2, reason: 'hash-mismatch' },
      ]),
    );
  });

  test('(b) texto livre alterado em data da linha 1', async () => {
    const lines = await logOfFive();
    const altered: EventLine = {
      ...lines[1],
      data: { ...lines[1].data, milestoneType: 'tampered' },
    };
    writeLog(environment, PROJ, PROC, [lines[0], altered, lines[2], lines[3], lines[4]]);
    const chain = await callChain();
    expect(chain.breaks).toEqual([{ index: 2, reason: 'hash-mismatch' }]);
    expect(chain.totalBreaks).toBe(1);
  });

  test('(c) linha 1 removida, sem cascata nos elos seguintes', async () => {
    const lines = await logOfFive();
    writeLog(environment, PROJ, PROC, [lines[0], lines[2], lines[3], lines[4]]);
    const chain = await callChain();
    expect(chain.totalBreaks).toBe(2);
    expect(chain.breaks).toEqual(
      expect.arrayContaining([
        { index: 1, reason: 'diverging-seq' },
        { index: 1, reason: 'hash-mismatch' },
      ]),
    );
  });

  test('(d) bytes parciais sem \\n no fim + novo registrar → repara e encadeia', async () => {
    const lines = await logOfFive();
    const text =
      lines.map((line) => JSON.stringify(line)).join('\n') +
      '\n' +
      JSON.stringify(lines[0]).slice(0, 10);
    fs.writeFileSync(path.join(environment.dir, PROJ, PROC, 'events.jsonl'), text);

    const registered = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData(),
    });
    expect((registered.structuredContent as { event: EventLine }).event.seq).toBe(6);

    const chain = await callChain();
    expect(chain.ok).toBe(true);
    expect(chain.breaks).toEqual([]);
    expect(chain.repairedLines).toEqual([5]);
  });

  test('(e) (a) + prevHash alterado na linha 4', async () => {
    const lines = await logOfFive();
    const alteredLine4: EventLine = { ...lines[4], prevHash: '0'.repeat(64) };
    writeLog(environment, PROJ, PROC, [
      lines[0],
      '{ broken json',
      lines[2],
      lines[3],
      alteredLine4,
    ]);
    const chain = await callChain();
    expect(chain.totalBreaks).toBe(3);
    expect(chain.breaks).toEqual(
      expect.arrayContaining([
        { index: 1, reason: 'invalid-line' },
        { index: 2, reason: 'hash-mismatch' },
        { index: 4, reason: 'hash-mismatch' },
      ]),
    );
  });

  test('(f) lixo com \\n anexado ao fim + registrar legítimo → repara', async () => {
    const lines = await logOfFive();
    const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n' + 'random garbage\n';
    fs.writeFileSync(path.join(environment.dir, PROJ, PROC, 'events.jsonl'), text);

    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData(),
    });

    const chain = await callChain();
    expect(chain.ok).toBe(true);
    expect(chain.repairedLines).toEqual([5]);
  });

  test('(g) (c) seguido de registrar legítimo → nenhuma quebra além das 2 de (c)', async () => {
    const lines = await logOfFive();
    writeLog(environment, PROJ, PROC, [lines[0], lines[2], lines[3], lines[4]]);

    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData(),
    });

    const chain = await callChain();
    expect(chain.totalBreaks).toBe(2);
    expect(chain.breaks).toEqual(
      expect.arrayContaining([
        { index: 1, reason: 'diverging-seq' },
        { index: 1, reason: 'hash-mismatch' },
      ]),
    );
  });
});

describe('N2', () => {
  test('(i) Milestone com dueAt em offset reenviado igual → deduplicado, mesmo seq, sem nova linha', async () => {
    await prepare(environment, PROJ, PROC);
    const data = milestoneData({ dueAt: '2026-09-16T18:00:00-03:00' });
    const first = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data,
    });
    const body1 = first.structuredContent as { event: EventLine };
    const before = environment.tree();

    const second = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: body1.event.id,
      agent: AGENT,
      data,
    });
    expectDeduplicated(second, body1.event.seq);
    expect(environment.tree()).toEqual(before);
  });

  test('(ii) tipo custom com default omitido, reenviado omitido ou explícito → deduplicado', async () => {
    await prepare(environment, PROJ, PROC);
    const first = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: NOTE_PREFIX,
      agent: AGENT,
      data: { note: 'x' },
    });
    const body1 = first.structuredContent as { event: EventLine };

    const resentOmitted = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: body1.event.id,
      agent: AGENT,
      data: { note: 'x' },
    });
    expectDeduplicated(resentOmitted, body1.event.seq);

    const resentExplicit = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: body1.event.id,
      agent: AGENT,
      data: { note: 'x', priority: 1 },
    });
    expectDeduplicated(resentExplicit, body1.event.seq);
  });

  test('(iii) Milestone com trace: schema aceita, e reenviar o mesmo id com trace diferente ainda deduplica (P5)', async () => {
    await prepare(environment, PROJ, PROC);
    const first = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData({ trace: 'first-trace' }),
    });
    expect(first.isError).not.toBe(true);
    const body1 = first.structuredContent as { event: EventLine };

    const resent = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: body1.event.id,
      agent: AGENT,
      data: milestoneData({ trace: 'different-trace' }),
    });
    expectDeduplicated(resent, body1.event.seq);
  });

  test('conteúdo diferente com o mesmo id completo → ID_CONFLITANTE', async () => {
    await prepare(environment, PROJ, PROC);
    const first = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData(),
    });
    const body1 = first.structuredContent as { event: EventLine };

    const conflicting = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: body1.event.id,
      agent: AGENT,
      data: milestoneData({ target: 'hex:target:other' }),
    });
    expectError(conflicting, 'CONFLICTING_ID');
  });
});

describe('N4', () => {
  test('milestoneType fora do vocabulário fixado → VOCABULARY_VIOLATED, sem linha', async () => {
    await prepare(environment, PROJ, PROC);
    const before = environment.tree();
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData({ milestoneType: 'unknown' }),
    });
    expectError(result, 'VOCABULARY_VIOLATED');
    expect(environment.tree()).toEqual(before);
  });

  test('decisions[].action fora do vocabulário fixado → VOCABULARY_VIOLATED, sem linha', async () => {
    await prepare(environment, PROJ, PROC);
    const before = environment.tree();
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData({ decisions: [{ item: 'i', action: 'outside-vocabulary', text: 't' }] }),
    });
    expectError(result, 'VOCABULARY_VIOLATED');
    expect(environment.tree()).toEqual(before);
  });

  test('VOCABULARY_VIOLATED.details[0] traz owners fixados e os termos aceitos do campo (P2)', async () => {
    await registerCore(environment, PROJ);
    await environment.call('register_vocabulary', {
      project: PROJ,
      owner: 'extra',
      milestoneType: ['extended'],
      result: [],
      action: [],
    });
    await environment.call('create_process', { project: PROJ, process: PROC });

    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData({ milestoneType: 'unknown' }),
    });
    const body = expectError(result, 'VOCABULARY_VIOLATED');
    // `owners` são só os donos de extensão (`byOwner`); "core" não é um owner fixável à parte.
    expect(body.details[0]).toMatchObject({
      owners: ['extra'],
      allowed: expect.arrayContaining(['approved', 'extended']),
    });
  });

  test('resultado fora do vocabulário fixado (campo fechado) → VOCABULARY_VIOLATED, sem linha', async () => {
    await prepare(environment, PROJ, PROC);
    const before = environment.tree();
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ result: 'unknown' }),
    });
    expectError(result, 'VOCABULARY_VIOLATED');
    expect(environment.tree()).toEqual(before);
  });

  test('position de um Voto fora do vocabulário (reaproveita a lista de result, continua campo aberto) → grava e devolve aviso UNKNOWN_VOCABULARY', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: `${PROJ}:${PROC}:vote`,
      agent: AGENT,
      data: {
        target: 'hex:target:u1',
        round: 'r1',
        votersExpected: 1,
        position: 'unknown',
        changed: false,
      },
    });
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as { warnings: { code: string }[] };
    expect(body.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_VOCABULARY' })]),
    );
  });
});

describe('N5', () => {
  test('no-orphans: estado limpo passa, Milestone vencido reprova com prova', async () => {
    await prepare(environment, PROJ, PROC);
    const clean = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENT,
      target: 'hex:target:u1',
    });
    const cleanBody = clean.structuredContent as { passed: boolean; evidence: unknown[] };
    expect(cleanBody.passed).toBe(true);
    expect(cleanBody.evidence).toEqual([]);

    environment.setClock(new Date('2026-06-01T00:00:00.000Z'));
    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData({ target: 'hex:target:u2', dueAt: '2026-01-01T00:00:00.000Z' }),
    });

    const violated = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENT,
      target: 'hex:target:u2',
    });
    const violatedBody = violated.structuredContent as { passed: boolean; evidence: unknown[] };
    expect(violatedBody.passed).toBe(false);
    expect(violatedBody.evidence.length).toBeGreaterThan(0);
  });

  test('chain-intact passa num log íntegro', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'chain-intact',
      agent: AGENT,
      target: 'hex:target:u1',
    });
    expect((result.structuredContent as { passed: boolean }).passed).toBe(true);
  });

  test('no-forks: 2 sucessores vivos do mesmo Verdict superado reprova (P1)', async () => {
    await prepare(environment, PROJ, PROC);
    const a = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ claim: 'a' }),
    });
    const aId = (a.structuredContent as { event: EventLine }).event.id;

    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ claim: 'b', supersedes: [aId] }),
    });
    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ claim: 'c', supersedes: [aId] }),
    });

    const forked = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-forks',
      agent: AGENT,
      target: 'hex:target:u1',
    });
    const forkedBody = forked.structuredContent as { passed: boolean; evidence: unknown[] };
    expect(forkedBody.passed).toBe(false);
    expect(forkedBody.evidence).toEqual([
      { verdict: aId, successors: expect.arrayContaining([expect.any(String)]) },
    ]);
  });
});

describe('N6', () => {
  test('gate custom sem resultado → AVALIACAO_INVALIDA', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'gate-custom',
      agent: AGENT,
      target: 'hex:target:u1',
    });
    expectError(result, 'INVALID_EVALUATION');
  });

  test('gate embutido com resultado informado → AVALIACAO_INVALIDA', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENT,
      target: 'hex:target:u1',
      result: { passed: true, evidence: 'ok' },
    });
    expectError(result, 'INVALID_EVALUATION');
  });

  test('gate não fixado, nem embutido nem no snapshot → GATE_NOT_REGISTERED', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'ghost',
      agent: AGENT,
      target: 'hex:target:u1',
      result: { passed: true, evidence: 'ok' },
    });
    expectError(result, 'GATE_NOT_REGISTERED');
  });

  test('gate registrado depois de create_process → GATE_NOT_REGISTERED', async () => {
    await prepare(environment, PROJ, PROC);
    await environment.call('register_gate', {
      project: PROJ,
      name: 'gate-late',
      criteria: 'late criteria',
    });
    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'gate-late',
      agent: AGENT,
      target: 'hex:target:u1',
      result: { passed: true, evidence: 'ok' },
    });
    expectError(result, 'GATE_NOT_REGISTERED');
  });

  test('gate custom aceito → Milestone de gate com criterio do snapshot e origem custom', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'gate-custom',
      agent: AGENT,
      target: 'hex:target:u1',
      result: { passed: false, evidence: ['evidence'] },
    });
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as { event: EventLine };
    const data = body.event.data as {
      milestoneType: string;
      gate: { name: string; origin: string; criteria: string; passed: boolean };
    };
    expect(data.milestoneType).toBe('gate');
    expect(data.gate.origin).toBe('custom');
    expect(data.gate.criteria).toBe('any custom criteria');
    expect(data.gate.passed).toBe(false);
  });
});

describe('N8', () => {
  test('timestamp termina em Z; dueAt com offset é normalizado para UTC', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData({ dueAt: '2026-09-16T18:00:00-03:00' }),
    });
    const body = result.structuredContent as { event: EventLine };
    expect(body.event.timestamp).toMatch(/Z$/);
    expect((body.event.data as { dueAt: string }).dueAt).toBe('2026-09-16T21:00:00.000Z');
  });
});

describe('N9', () => {
  test('prefixo gera id no formato projeto:processo:tipo:uuidv7', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData(),
    });
    const body = result.structuredContent as { event: EventLine };
    expect(body.event.id).toMatch(new RegExp(`^${PROJ}:${PROC}:milestone:[0-9a-f-]{36}$`));
  });

  test('projeto/processo do id divergente dos parâmetros → ID_INVALIDO', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: `other-project:${PROC}:milestone`,
      agent: AGENT,
      data: milestoneData(),
    });
    expectError(result, 'INVALID_ID');
  });

  test('tipo não fixado no processo → TYPE_NOT_PINNED', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: `${PROJ}:${PROC}:ghost`,
      agent: AGENT,
      data: { x: 1 },
    });
    expectError(result, 'TYPE_NOT_PINNED');
  });

  test('id completo inexistente → ID_DESCONHECIDO', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: `${MILESTONE_PREFIX}:${randomUUIDv7()}`,
      agent: AGENT,
      data: milestoneData(),
    });
    expectError(result, 'UNKNOWN_ID');
  });
});

describe('N12', () => {
  test.each(['u1', 'hex:target:', 'hex:target:a:b', 'hex:target:a b', 'hex:other:x'])(
    'target %s inválido em Milestone → INVALID_EVENT em /data/target, sem linha',
    async (invalidTarget) => {
      await prepare(environment, PROJ, PROC);
      const before = environment.tree();
      const result = await environment.call('register', {
        project: PROJ,
        process: PROC,
        id: MILESTONE_PREFIX,
        agent: AGENT,
        data: milestoneData({ target: invalidTarget }),
      });
      const body = expectError(result, 'INVALID_EVENT');
      expect(body.details).toContainEqual(expect.objectContaining({ path: '/data/target' }));
      expect(environment.tree()).toEqual(before);
    },
  );

  test('target inválido em Verdict → INVALID_EVENT em /data/target', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ target: 'hex:other:x' }),
    });
    const body = expectError(result, 'INVALID_EVENT');
    expect(body.details).toContainEqual(expect.objectContaining({ path: '/data/target' }));
  });

  test('hex:target:u1 é aceito', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData(),
    });
    expect(result.isError).not.toBe(true);
  });

  test('evaluate_gate com target: "u1" → Input validation error, sem linha', async () => {
    await prepare(environment, PROJ, PROC);
    const before = environment.tree();
    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENT,
      target: 'u1',
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/^Input validation error/);
    expect(environment.tree()).toEqual(before);
  });
});

describe('N13', () => {
  test('Milestone vencido gera órfão; evaluate_gate não o remove de state.orphans', async () => {
    await prepare(environment, PROJ, PROC);
    environment.setClock(new Date('2026-06-01T00:00:00.000Z'));
    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData({ target: 'hex:target:x', dueAt: '2026-01-01T00:00:00.000Z' }),
    });

    const before = await environment.call('state', {
      project: PROJ,
      process: PROC,
      sections: ['orphans'],
    });
    expect((before.structuredContent as { orphans: unknown[] }).orphans).toHaveLength(1);

    const evaluated = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENT,
      target: 'hex:target:x',
    });
    expect((evaluated.structuredContent as { passed: boolean }).passed).toBe(false);

    const after = await environment.call('state', {
      project: PROJ,
      process: PROC,
      sections: ['orphans'],
    });
    expect((after.structuredContent as { orphans: unknown[] }).orphans).toHaveLength(1);
  });

  test('Milestone de gate sozinho num target não cria abertura', async () => {
    await prepare(environment, PROJ, PROC);
    await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENT,
      target: 'hex:target:y',
    });

    environment.setClock(new Date('2099-01-01T00:00:00.000Z'));
    const result = await environment.call('state', {
      project: PROJ,
      process: PROC,
      sections: ['orphans'],
    });
    const orphans = (result.structuredContent as { orphans: { target: string }[] }).orphans;
    expect(orphans.some((orphan) => orphan.target === 'hex:target:y')).toBe(false);
  });
});

describe('N14', () => {
  test('prevHash do 1º elo é a âncora de process.json', async () => {
    await prepare(environment, PROJ, PROC);
    const registered = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData(),
    });
    const event = (registered.structuredContent as { event: EventLine }).event;
    expect(event.prevHash).toBe(anchor(readManifest(environment, PROJ, PROC)));
  });

  test('fixado alterado com hashes recalculados → cadeia.breaks inclui {0, hash-nao-bate}', async () => {
    await prepare(environment, PROJ, PROC);
    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData(),
    });

    const manifestPath = path.join(environment.dir, PROJ, PROC, 'process.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      fixed: { vocabulary: { core: { milestoneType: string[] } } };
      hashes: { schemas: string; vocabulary: string; gates: string };
    };
    manifest.fixed.vocabulary.core.milestoneType.push('other-value');
    manifest.hashes.vocabulary = sha256hex(canonicalize(manifest.fixed.vocabulary) ?? '');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const chain = (await environment.call('chain', { project: PROJ, process: PROC }))
      .structuredContent as Chain;
    expect(chain.breaks).toEqual(expect.arrayContaining([{ index: 0, reason: 'hash-mismatch' }]));
  });
});

describe('critério 10 (Leva 6) — não-regressão: lock por processo sobrevive a um bump de vocabulário', () => {
  test('vocabulário bumpado pra major fora do processo (removendo "approved") não afeta o processo já fixado', async () => {
    await prepare(environment, PROJ, PROC);
    const firstEvent = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData(),
    });
    expect(firstEvent.isError).not.toBe(true);

    const stateBefore = await environment.call('state', { project: PROJ, process: PROC });
    const eventsBefore = await environment.call('events', { project: PROJ, process: PROC });
    const chainBefore = await environment.call('chain', { project: PROJ, process: PROC });

    // Simula, fora do fluxo de `register_vocabulary` (cujo `breaking` ainda não está na
    // superfície MCP — leva 7), uma versão major do vocabulário "core" que remove "approved".
    fs.writeFileSync(
      path.join(environment.dir, PROJ, 'vocabulary', 'core', '2.0.json'),
      JSON.stringify({
        owner: 'core',
        milestoneType: ['other'],
        result: ['ok'],
        action: ['follow'],
        hash: 'irrelevant-for-this-test',
        registeredAt: new Date().toISOString(),
      }),
    );

    // O processo antigo lê `manifest.fixed.vocabulary`, não o disco vigente: nada muda pra ele.
    expect(await environment.call('state', { project: PROJ, process: PROC })).toEqual(stateBefore);
    expect(await environment.call('events', { project: PROJ, process: PROC })).toEqual(
      eventsBefore,
    );
    expect(await environment.call('chain', { project: PROJ, process: PROC })).toEqual(chainBefore);

    const secondEvent = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData({ target: 'hex:target:u2' }),
    });
    expect(secondEvent.isError).not.toBe(true);
  });
});

describe('S2', () => {
  test('evento custom válido vira elo', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: NOTE_PREFIX,
      agent: AGENT,
      data: { note: 'ok', category: 'a' },
    });
    expect(result.isError).not.toBe(true);
  });

  test('chave extra → EVENTO_INVALIDO em /data/..., sem linha', async () => {
    await prepare(environment, PROJ, PROC);
    const before = environment.tree();
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: NOTE_PREFIX,
      agent: AGENT,
      data: { note: 'ok', extra: 1 },
    });
    const body = expectError(result, 'INVALID_EVENT');
    expect(body.details[0]?.path.startsWith('/data')).toBe(true);
    expect(environment.tree()).toEqual(before);
  });

  test('enum inválido → EVENTO_INVALIDO em /data/categoria', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: NOTE_PREFIX,
      agent: AGENT,
      data: { note: 'ok', category: 'outside' },
    });
    const body = expectError(result, 'INVALID_EVENT');
    expect(body.details).toContainEqual(expect.objectContaining({ path: '/data/category' }));
  });

  test('format date-time inválido → EVENTO_INVALIDO em /data/quando', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: NOTE_PREFIX,
      agent: AGENT,
      data: { note: 'ok', when: 'not-a-date' },
    });
    const body = expectError(result, 'INVALID_EVENT');
    expect(body.details).toContainEqual(expect.objectContaining({ path: '/data/when' }));
  });
});

describe('S3', () => {
  test('eventos custom aparecem em eventos e ficam inertes na projeção do State', async () => {
    await prepare(environment, PROJ, PROC);

    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: milestoneData({ target: 'hex:target:a', dueAt: '2025-01-01T00:00:00.000Z' }),
    });
    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: NOTE_PREFIX,
      agent: AGENT,
      data: { note: 'interleaved' },
    });
    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ target: 'hex:target:a', claim: 'a1' }),
    });

    const eventsResult = (await environment.call('events', { project: PROJ, process: PROC }))
      .structuredContent as { events: EventLine[] };
    expect(eventsResult.events.map((event) => event.type)).toEqual([
      'milestone',
      'note',
      'verdict',
    ]);

    const state = (await environment.call('state', { project: PROJ, process: PROC }))
      .structuredContent as {
      active: unknown[];
      orphans: unknown[];
      conflicts: unknown[];
      toReview: unknown[];
      invalidReferences: unknown[];
    };
    // o Verdict fecha o ciclo do Milestone: sem o custom intercalado no meio, o result seria idêntico.
    expect(state.active).toHaveLength(1);
    expect(state.orphans).toEqual([]);
    expect(state.conflicts).toEqual([]);
    expect(state.toReview).toEqual([]);
    expect(state.invalidReferences).toEqual([]);
  });
});

describe('S5', () => {
  test('schema, vocabulário e gate alterados entre a criação de dois processos: cada um usa sua versão', async () => {
    const project = 'p-s5';
    const oldSchema = {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
      additionalProperties: false,
    };
    const newSchema = {
      type: 'object',
      properties: { note: { type: 'string' }, extra: { type: 'string' } },
      required: ['note'],
      additionalProperties: false,
    };

    await environment.call('register_vocabulary', {
      project,
      owner: 'core',
      milestoneType: ['v1'],
      result: [],
      action: [],
    });
    await environment.call('register_type', { project, name: 'note', schema: oldSchema });
    await environment.call('register_gate', { project, name: 'g', criteria: 'v1' });
    await environment.call('create_process', { project, process: 'proc-old' });

    await environment.call('register_vocabulary', {
      project,
      owner: 'core',
      milestoneType: ['v1', 'v2'],
      result: [],
      action: [],
    });
    await environment.call('register_type', {
      project,
      name: 'note',
      schema: newSchema,
      breaking: true,
    });
    await environment.call('register_gate', { project, name: 'g', criteria: 'v2' });
    await environment.call('create_process', { project, process: 'proc-new' });

    const oldV1 = await environment.call('register', {
      project,
      process: 'proc-old',
      id: `${project}:proc-old:milestone`,
      agent: AGENT,
      data: { milestoneType: 'v1', target: 'hex:target:u1' },
    });
    expect(oldV1.isError).not.toBe(true);

    const oldV2 = await environment.call('register', {
      project,
      process: 'proc-old',
      id: `${project}:proc-old:milestone`,
      agent: AGENT,
      data: { milestoneType: 'v2', target: 'hex:target:u1' },
    });
    expectError(oldV2, 'VOCABULARY_VIOLATED');

    const newV2 = await environment.call('register', {
      project,
      process: 'proc-new',
      id: `${project}:proc-new:milestone`,
      agent: AGENT,
      data: { milestoneType: 'v2', target: 'hex:target:u1' },
    });
    expect(newV2.isError).not.toBe(true);

    const newExtra = await environment.call('register', {
      project,
      process: 'proc-new',
      id: `${project}:proc-new:note`,
      agent: AGENT,
      data: { note: 'x', extra: 'y' },
    });
    expect(newExtra.isError).not.toBe(true);

    const oldExtra = await environment.call('register', {
      project,
      process: 'proc-old',
      id: `${project}:proc-old:note`,
      agent: AGENT,
      data: { note: 'x', extra: 'y' },
    });
    expectError(oldExtra, 'INVALID_EVENT');

    const oldGateResult = (
      await environment.call('evaluate_gate', {
        project,
        process: 'proc-old',
        gate: 'g',
        agent: AGENT,
        target: 'hex:target:u1',
        result: { passed: true, evidence: 'ok' },
      })
    ).structuredContent as { event: EventLine };
    expect((oldGateResult.event.data as { gate: { criteria: string } }).gate.criteria).toBe('v1');

    const newGateResult = (
      await environment.call('evaluate_gate', {
        project,
        process: 'proc-new',
        gate: 'g',
        agent: AGENT,
        target: 'hex:target:u1',
        result: { passed: true, evidence: 'ok' },
      })
    ).structuredContent as { event: EventLine };
    expect((newGateResult.event.data as { gate: { criteria: string } }).gate.criteria).toBe('v2');
  });
});

describe('RESERVED_FIELD', () => {
  test('Milestone com milestoneType "gate" → RESERVED_FIELD, sem linha', async () => {
    await prepare(environment, PROJ, PROC);
    const before = environment.tree();
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: { milestoneType: 'gate', target: 'hex:target:u1', gate: { name: 'x' } },
    });
    expectError(result, 'RESERVED_FIELD');
    expect(environment.tree()).toEqual(before);
  });

  test('Milestone com chave "gate", mesmo sem milestoneType "gate" → RESERVED_FIELD', async () => {
    await prepare(environment, PROJ, PROC);
    const result = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: MILESTONE_PREFIX,
      agent: AGENT,
      data: { milestoneType: 'approved', target: 'hex:target:u1', gate: 'whatever' },
    });
    expectError(result, 'RESERVED_FIELD');
  });
});

describe('Mudança 3 (leva 2) — transitions / ordem de fase', () => {
  const TARGET = 'hex:target:t1';

  /** Vocabulário com draft/review/done e transitions null->draft->review->done, mais o process fixado. */
  async function prepareWithTransitions(project: string, process: string): Promise<void> {
    await environment.call('register_vocabulary', {
      project,
      owner: 'core',
      milestoneType: ['draft', 'review', 'done'],
      result: [],
      action: [],
      transitions: [
        { from: null, to: 'draft' },
        { from: 'draft', to: 'review' },
        { from: 'review', to: 'done' },
      ],
    });
    await environment.call('create_process', { project, process });
  }

  function registerMilestone(
    project: string,
    process: string,
    milestoneType: string,
  ): Promise<CallResult> {
    return environment.call('register', {
      project,
      process,
      id: `${project}:${process}:milestone`,
      agent: AGENT,
      data: { milestoneType, target: TARGET },
    });
  }

  test('register_vocabulary com transitions grava a versão sob a chave transitions da resposta', async () => {
    const project = 'transitions-write';
    const result = await environment.call('register_vocabulary', {
      project,
      owner: 'core',
      milestoneType: ['draft'],
      result: [],
      action: [],
      transitions: [{ from: null, to: 'draft' }],
    });
    const body = result.structuredContent as {
      transitions?: { version: string; unchanged: boolean };
    };
    expect(body.transitions).toEqual(expect.objectContaining({ version: '1.0', unchanged: false }));
    expect(
      fs.existsSync(path.join(environment.dir, project, 'transitions', 'core', '1.0.json')),
    ).toBe(true);
  });

  test('primeira fase (from: null) aceita, e a ordem correta encadeia sem erro', async () => {
    const project = 'transitions-happy';
    await prepareWithTransitions(project, PROC);

    const first = await registerMilestone(project, PROC, 'draft');
    expect(first.isError).not.toBe(true);
    const second = await registerMilestone(project, PROC, 'review');
    expect(second.isError).not.toBe(true);
    const third = await registerMilestone(project, PROC, 'done');
    expect(third.isError).not.toBe(true);
  });

  test('fase fora de ordem rejeita com INVALID_TRANSITION, listando os from aceitos', async () => {
    const project = 'transitions-out-of-order';
    await prepareWithTransitions(project, PROC);
    await registerMilestone(project, PROC, 'draft');

    // 'done' só aceita from: 'review'; a fase atual é 'draft'.
    const rejected = await registerMilestone(project, PROC, 'done');
    const body = expectError(rejected, 'INVALID_TRANSITION');
    expect(body.details[0].message).toContain('review');
  });

  test('milestoneType sem nenhum par declarado fica sem restrição (opt-in por milestoneType)', async () => {
    const project = 'transitions-optin';
    await environment.call('register_vocabulary', {
      project,
      owner: 'core',
      milestoneType: ['draft', 'free'],
      result: [],
      action: [],
      transitions: [{ from: null, to: 'draft' }],
    });
    await environment.call('create_process', { project, process: PROC });

    const result = await registerMilestone(project, PROC, 'free');
    expect(result.isError).not.toBe(true);
  });

  test('regressão: processo sem transitions registradas continua aceitando milestone fora de ordem', async () => {
    const project = 'transitions-none';
    await environment.call('register_vocabulary', {
      project,
      owner: 'core',
      milestoneType: ['draft', 'review'],
      result: [],
      action: [],
    });
    await environment.call('create_process', { project, process: PROC });

    await registerMilestone(project, PROC, 'review');
    const result = await registerMilestone(project, PROC, 'draft');
    expect(result.isError).not.toBe(true);
  });

  test('state.phases reflete a fase atual do target e ignora Milestone de gate', async () => {
    const project = 'transitions-phases';
    await prepareWithTransitions(project, PROC);
    await registerMilestone(project, PROC, 'draft');
    await environment.call('evaluate_gate', {
      project,
      process: PROC,
      gate: 'no-orphans',
      agent: AGENT,
      target: TARGET,
    });

    const state = await environment.call('state', { project, process: PROC });
    const body = state.structuredContent as { phases: { target: string; current: string }[] };
    expect(body.phases).toEqual([{ target: TARGET, current: 'draft' }]);
  });

  test('create_process(project, "transitions") rejeita com RESERVED_NAME; list(project) não lista "transitions" como processo', async () => {
    const project = 'transitions-reserved';
    await environment.call('register_vocabulary', { project, owner: 'core' });
    const created = await environment.call('create_process', { project, process: 'transitions' });
    expectError(created, 'RESERVED_NAME');

    await environment.call('create_process', { project, process: 'p1' });
    const listed = await environment.call('list', { project });
    const body = listed.structuredContent as { project: { processes: { name: string }[] } };
    expect(body.project.processes.map((p) => p.name)).toEqual(['p1']);
  });

  test('B2: reenviar Marco pelo id completo depois da fase avançar → deduplicated, não INVALID_TRANSITION', async () => {
    const project = 'transitions-retry-dedupe';
    await prepareWithTransitions(project, PROC);

    const draft = await registerMilestone(project, PROC, 'draft');
    const draftBody = draft.structuredContent as { event: EventLine };

    const review = await registerMilestone(project, PROC, 'review');
    expect(review.isError).not.toBe(true);

    // Reenvio do Marco 'draft' original pelo id completo (mesmo uuid, mesmo dado): a fase real já
    // avançou para 'review', mas o dedupe por id completo tem prioridade sobre a validação de ordem,
    // que só se aplica a um registro novo.
    const retried = await environment.call('register', {
      project,
      process: PROC,
      id: draftBody.event.id,
      agent: AGENT,
      data: { milestoneType: 'draft', target: TARGET },
    });
    expectDeduplicated(retried, draftBody.event.seq);
  });
});

describe('Mudança 2 (leva 3) — votos / rodada às cegas', () => {
  const VOTE_TARGET = 'hex:target:jury-1';
  const VOTE_PREFIX = `${PROJ}:${PROC}:vote`;

  function voteData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      target: VOTE_TARGET,
      round: 'r1',
      votersExpected: 3,
      position: 'ok',
      changed: false,
      ...overrides,
    };
  }

  async function castVote(
    agent: string,
    overrides: Record<string, unknown> = {},
  ): Promise<CallResult> {
    return environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VOTE_PREFIX,
      agent,
      data: voteData(overrides),
    });
  }

  type VoteEvent = EventLine & { redacted?: boolean };

  function eventsById(events: VoteEvent[]): Record<string, VoteEvent> {
    return Object.fromEntries(events.map((event) => [event.id, event]));
  }

  test('3 votantes: votos 1 e 2 vêm redigidos em events e state; o 3º revela os 3 por igual, mesmo os já lidos redigidos antes', async () => {
    await registerCore(environment, PROJ);
    await environment.call('create_process', { project: PROJ, process: PROC });

    const first = await castVote('voter-1', { position: 'ok' });
    const firstId = (first.structuredContent as { event: EventLine }).event.id;
    const second = await castVote('voter-2', { position: 'ok' });
    const secondId = (second.structuredContent as { event: EventLine }).event.id;

    const afterTwo = await environment.call('events', { project: PROJ, process: PROC });
    const afterTwoBody = afterTwo.structuredContent as { events: VoteEvent[] };
    const afterTwoById = eventsById(afterTwoBody.events);
    for (const id of [firstId, secondId]) {
      expect(afterTwoById[id].redacted).toBe(true);
      // B4: o conjunto de chaves é sempre TODO campo de VoteData (events.ts), byte a byte igual pra
      // qualquer voto da rodada — mesmo confidence/flipReason/trace, que este voto nunca enviou,
      // aparecem como null. A ausência de uma chave optional também seria sinal (flipReason só
      // existe quando changed: true), então a chave nasce sempre presente, nula até a revelação.
      expect(afterTwoById[id].data).toEqual({
        target: VOTE_TARGET,
        round: 'r1',
        votersExpected: 3,
        position: null,
        confidence: null,
        changed: null,
        flipReason: null,
        trace: null,
      });
    }

    const stateAfterTwo = await environment.call('state', {
      project: PROJ,
      process: PROC,
      sections: ['voteRounds'],
    });
    expect(
      (
        stateAfterTwo.structuredContent as {
          voteRounds: { votesReceived: number; votersExpected: number; revealed: boolean }[];
        }
      ).voteRounds,
    ).toEqual([
      { target: VOTE_TARGET, round: 'r1', votersExpected: 3, votesReceived: 2, revealed: false },
    ]);

    const third = await castVote('voter-3', { position: 'not-ok' });
    const thirdId = (third.structuredContent as { event: EventLine }).event.id;

    const afterThree = await environment.call('events', { project: PROJ, process: PROC });
    const afterThreeBody = afterThree.structuredContent as { events: VoteEvent[] };
    const afterThreeById = eventsById(afterThreeBody.events);
    expect(afterThreeById[firstId].redacted).toBeUndefined();
    expect(afterThreeById[firstId].data.position).toBe('ok');
    expect(afterThreeById[secondId].redacted).toBeUndefined();
    expect(afterThreeById[secondId].data.position).toBe('ok');
    expect(afterThreeById[thirdId].redacted).toBeUndefined();
    expect(afterThreeById[thirdId].data.position).toBe('not-ok');

    const stateAfterThree = await environment.call('state', {
      project: PROJ,
      process: PROC,
      sections: ['voteRounds'],
    });
    expect(
      (stateAfterThree.structuredContent as { voteRounds: { revealed: boolean }[] }).voteRounds,
    ).toEqual([
      { target: VOTE_TARGET, round: 'r1', votersExpected: 3, votesReceived: 3, revealed: true },
    ]);
  });

  test('B4: voto que mudou de posição (changed+flipReason) fica indistinguível de um que não mudou, mesma rodada aberta', async () => {
    await registerCore(environment, PROJ);
    await environment.call('create_process', { project: PROJ, process: PROC });

    await castVote('voter-1', { changed: true, flipReason: 'mudei de ideia', confidence: 0.9 });
    await castVote('voter-2', { changed: false });

    const result = await environment.call('events', { project: PROJ, process: PROC });
    const body = result.structuredContent as { events: VoteEvent[] };
    const votes = body.events.filter((event) => event.type === 'vote');
    expect(votes).toHaveLength(2);
    expect(votes.every((vote) => vote.redacted)).toBe(true);

    const [keysA, keysB] = votes.map((vote) => Object.keys(vote.data).sort());
    expect(keysA).toEqual(keysB);
  });

  test('votersExpected divergente na mesma rodada → VOTE_ROUND_MISMATCH, sem gravar linha nova', async () => {
    await registerCore(environment, PROJ);
    await environment.call('create_process', { project: PROJ, process: PROC });

    await castVote('voter-1', { votersExpected: 3 });
    const eventsFile = path.join(environment.dir, PROJ, PROC, 'events.jsonl');
    const before = fs.readFileSync(eventsFile, 'utf8');

    const mismatched = await castVote('voter-2', { votersExpected: 5 });
    expectError(mismatched, 'VOTE_ROUND_MISMATCH');
    expect(fs.readFileSync(eventsFile, 'utf8')).toBe(before);
  });

  test('busca por termo só em position de um voto de rodada aberta não retorna a linha; após revelar, retorna; invalidLines não acusa a exclusão', async () => {
    await registerCore(environment, PROJ);
    await environment.call('create_process', { project: PROJ, process: PROC });

    const hiddenTerm = 'xyzzy-secret-position';
    await castVote('voter-1', { votersExpected: 2, position: hiddenTerm });

    const beforeReveal = await environment.call('events', {
      project: PROJ,
      process: PROC,
      search: hiddenTerm,
    });
    const beforeBody = beforeReveal.structuredContent as {
      events: EventLine[];
      invalidLines: number[];
    };
    expect(beforeBody.events).toEqual([]);
    // Precisão de implementação (polimento pós-APPROVE): exclusão por rodada aberta é filtro por
    // desenho, não linha corrompida — não pode aparecer em invalidLines.
    expect(beforeBody.invalidLines).toEqual([]);

    await castVote('voter-2', { votersExpected: 2, position: hiddenTerm });

    const afterReveal = await environment.call('events', {
      project: PROJ,
      process: PROC,
      search: hiddenTerm,
    });
    const afterBody = afterReveal.structuredContent as { events: EventLine[] };
    expect(afterBody.events.length).toBe(2);
  });

  test('B1: duas register concorrentes pro mesmo target/round — a segunda falha em vez de gravar votersExpected divergente', async () => {
    await registerCore(environment, PROJ);
    await environment.call('create_process', { project: PROJ, process: PROC });

    // Sem a validação dentro do lock, as duas liam o mesmo estado "rodada ainda sem votersExpected
    // fixado" antes de qualquer escrita e passavam juntas — gravando votersExpected divergente na
    // mesma rodada sem erro nenhum.
    const [first, second] = await Promise.all([
      castVote('voter-1', { votersExpected: 2 }),
      castVote('voter-2', { votersExpected: 5 }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((result) => result.isError !== true)).toHaveLength(1);
    const [failed] = outcomes.filter((result) => result.isError === true);
    expectError(failed, 'VOTE_ROUND_MISMATCH');
  });

  test('B4: trace de voto de rodada aberta não vaza em events (raw) — allowlist nula tudo fora de target/round/votersExpected', async () => {
    await registerCore(environment, PROJ);
    await environment.call('create_process', { project: PROJ, process: PROC });

    const secretTrace = 'raciocinio-secreto-do-voto';
    await castVote('voter-1', { votersExpected: 2, trace: secretTrace });

    const result = await environment.call('events', { project: PROJ, process: PROC });
    const body = result.structuredContent as {
      events: (EventLine & { redacted?: boolean })[];
    };
    const vote = body.events.find((event) => event.type === 'vote');
    expect(vote?.redacted).toBe(true);
    expect(vote?.data).toMatchObject({
      target: VOTE_TARGET,
      round: 'r1',
      votersExpected: 2,
      trace: null,
    });
    expect(JSON.stringify(vote?.data)).not.toContain(secretTrace);
  });
});

describe('Mudança 1 (leva 4) — gate de regra', () => {
  const RULE_GATE = 'gate-regra';

  const RULE = {
    targetPattern: 'hex:target:u',
    requireVigente: true,
    acceptedResults: ['ok'],
    minCount: 1,
  };

  /** Vocabulário núcleo + gate de regra + gate de opinião (sem `rule`), com o process fixado. */
  async function prepareRuleGate(environment: Environment): Promise<void> {
    await registerCore(environment, PROJ);
    await environment.call('register_gate', {
      project: PROJ,
      name: RULE_GATE,
      criteria: 'at least 1 vigent verdict under hex:target:u with claim ok',
      rule: RULE,
    });
    await environment.call('register_gate', {
      project: PROJ,
      name: 'gate-custom',
      criteria: 'any custom criteria',
    });
    await environment.call('create_process', { project: PROJ, process: PROC });
  }

  test('gate de regra sem result: reprova com estado vazio, aprova depois de um Verdict vigente que bate a regra', async () => {
    await prepareRuleGate(environment);

    const empty = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: RULE_GATE,
      agent: AGENT,
      target: 'hex:target:u1',
    });
    expect(empty.isError).not.toBe(true);
    expect((empty.structuredContent as { passed: boolean }).passed).toBe(false);

    await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ target: 'hex:target:u1', claim: 'ok', result: 'ok' }),
    });

    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: RULE_GATE,
      agent: AGENT,
      target: 'hex:target:u1',
    });
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as {
      passed: boolean;
      evidence: unknown[];
      event: EventLine;
    };
    expect(body.passed).toBe(true);
    expect(body.evidence).toEqual(['hex:target:u1']);
    const data = body.event.data as {
      milestoneType: string;
      gate: { name: string; origin: string; criteria: string; passed: boolean };
    };
    expect(data.milestoneType).toBe('gate');
    expect(data.gate.origin).toBe('rule');
    expect(data.gate.criteria).toBe('at least 1 vigent verdict under hex:target:u with claim ok');
  });

  test('gate de regra com result informado → INVALID_EVALUATION, não RESERVED_FIELD', async () => {
    await prepareRuleGate(environment);

    const result = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: RULE_GATE,
      agent: AGENT,
      target: 'hex:target:u1',
      result: { passed: true, evidence: 'ok' },
    });
    expectError(result, 'INVALID_EVALUATION');
  });

  test('regressão: gate custom sem rule continua exigindo e aceitando result do agente, exatamente como hoje', async () => {
    await prepareRuleGate(environment);

    const withoutResult = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'gate-custom',
      agent: AGENT,
      target: 'hex:target:u1',
    });
    expectError(withoutResult, 'INVALID_EVALUATION');

    const withResult = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: 'gate-custom',
      agent: AGENT,
      target: 'hex:target:u1',
      result: { passed: true, evidence: 'ok' },
    });
    expect(withResult.isError).not.toBe(true);
    const data = (withResult.structuredContent as { event: EventLine }).event.data as {
      gate: { origin: string; passed: boolean };
    };
    expect(data.gate.origin).toBe('custom');
    expect(data.gate.passed).toBe(true);
  });

  test('bypass fechado: agente não cunha um result fora do vocabulário pra satisfazer acceptedResults de um gate de regra', async () => {
    await registerCore(environment, PROJ);
    await environment.call('register_gate', {
      project: PROJ,
      name: RULE_GATE,
      criteria: 'accepts a result never registered in the fixed vocabulary',
      rule: { ...RULE, acceptedResults: ['forged-pass'] },
    });
    await environment.call('create_process', { project: PROJ, process: PROC });

    const write = await environment.call('register', {
      project: PROJ,
      process: PROC,
      id: VERDICT_PREFIX,
      agent: AGENT,
      data: verdictData({ target: 'hex:target:u1', claim: 'x', result: 'forged-pass' }),
    });
    expectError(write, 'VOCABULARY_VIOLATED');

    const gateResult = await environment.call('evaluate_gate', {
      project: PROJ,
      process: PROC,
      gate: RULE_GATE,
      agent: AGENT,
      target: 'hex:target:u1',
    });
    expect((gateResult.structuredContent as { passed: boolean }).passed).toBe(false);
  });
});
