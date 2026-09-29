import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import canonicalize from 'canonicalize';
import { omit } from 'es-toolkit';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { normalizeData } from '../src/events.ts';
import { at, createEnvironment, expectError, registerCore, type Environment } from './helpers.ts';

const PROJECT = 'audit';
const PROCESS = 'omc-plan';
const AGENT = 'hexlog-flow';
const TARGET = 'hex:target:plano-x';

const TYPES_DIR = path.resolve(__dirname, '../.hexlog/types');
const TYPE_NAMES = [
  'planner-adr',
  'architect-review',
  'critic-findings',
  'plan-iteration-diff',
  'deviation',
] as const;
type TypeName = (typeof TYPE_NAMES)[number];

const DATA_MAX_CHARS = 16_000;

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(TYPES_DIR, `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

// ---- instâncias de pior caso (ADR 0006): todo string no maxLength, arrays no máximo ----

const HASH = 'a'.repeat(64);
// `project:process:type:uuid` no máximo do padrão: 3 nomes de 63 + 3 ':' + uuid de 36 = 228
const FULLID = `${'a'.repeat(63)}:${'b'.repeat(63)}:${'c'.repeat(63)}:01234567-89ab-7cde-8f01-23456789abcd`;

/** `fill` = `a` (×1: cada caractere pesa 1 canônico) ou `"` (×2: vira `\"`, pesa 2). */
function worstCase(
  name: TypeName,
  fill: string,
  supersedes: string[] = Array.from({ length: 4 }, () => FULLID),
): object {
  const s = (n: number) => fill.repeat(n);
  const many = <T>(count: number, item: T) => Array.from({ length: count }, () => item);
  const target = `hex:target:${fill.repeat(189)}`;

  switch (name) {
    case 'planner-adr':
      return {
        target,
        iteration: 20,
        source: s(100),
        principles: many(5, s(200)),
        drivers: many(5, s(200)),
        options: many(6, { name: s(80), pros: s(250), cons: s(250) }),
        chosen: s(240),
        why: s(1000),
        attachment: HASH,
      };
    case 'architect-review':
      return {
        target,
        iteration: 20,
        source: s(100),
        antithesis: s(1500),
        tradeoffs: many(5, s(350)),
        synthesis: s(1500),
        verdict: s(200),
        attachment: HASH,
      };
    case 'critic-findings':
      return {
        target,
        iteration: 20,
        source: s(100),
        verdict: 'accept-with-reservations',
        justification: s(1200),
        findings: many(12, { severity: 'critical', finding: s(220), whyItMatters: s(220) }),
        attachment: HASH,
      };
    case 'plan-iteration-diff':
      return {
        target,
        iteration: 20,
        source: s(100),
        changed: many(10, { change: s(250), motivatedBy: { finding: s(250), event: FULLID } }),
        supersedes,
        attachment: HASH,
      };
    case 'deviation':
      return {
        target,
        source: s(100),
        trigger: 'verification-failure',
        symptom: s(700),
        cause: s(700),
        attempts: many(8, { action: s(200), result: s(200) }),
        alternatives: many(5, { option: s(200), whyDiscarded: s(200) }),
        outcome: { status: 'worked-around', decidedBy: 'orchestrator', affected: s(200) },
        attachment: HASH,
        relatedEvent: FULLID,
      };
  }
}

/** Instância mínima válida, para os testes de rejeição. */
function minimal(name: TypeName): Record<string, unknown> {
  const base = { target: TARGET, source: 'oh-my-claudecode:planner' };
  switch (name) {
    case 'planner-adr':
      return { ...base, iteration: 1, chosen: 'A', why: 'porque sim', attachment: HASH };
    case 'architect-review':
      return {
        ...base,
        iteration: 1,
        antithesis: 'a',
        tradeoffs: ['t'],
        synthesis: 's',
        verdict: 'ok',
        attachment: HASH,
      };
    case 'critic-findings':
      return {
        ...base,
        iteration: 1,
        verdict: 'revise',
        justification: 'j',
        findings: [],
        attachment: HASH,
      };
    case 'plan-iteration-diff':
      return {
        ...base,
        iteration: 2,
        changed: [{ change: 'c', motivatedBy: { finding: 'f' } }],
        supersedes: [FULLID],
      };
    case 'deviation':
      return {
        ...base,
        trigger: 'other',
        symptom: 'sintoma',
        cause: 'causa',
        attempts: [],
        alternatives: [],
        outcome: { status: 'resolved', decidedBy: 'executor', affected: 'nada' },
      };
  }
}

function canonicalLength(value: object): number {
  return (canonicalize(value) ?? '').length;
}

describe('S2: schemas versionados em .hexlog/types', () => {
  test('são exatamente os cinco tipos de auditoria do ADR 0006, cada um com raiz object fechada', () => {
    expect(fs.readdirSync(TYPES_DIR).sort()).toEqual(
      TYPE_NAMES.map((name) => `${name}.json`).sort(),
    );
    for (const name of TYPE_NAMES) {
      expect(loadSchema(name)).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  test.each(TYPE_NAMES)(
    '%s: instância de pior caso ×1 e ×2 cabe em 16.000 canônicos (Ajv/zod compilam o schema)',
    (name) => {
      const customSchemas = {
        [name]: z.fromJSONSchema(loadSchema(name)),
      };
      for (const fill of ['a', '"']) {
        const normalized = normalizeData(name, worstCase(name, fill), customSchemas);
        expect(canonicalLength(normalized)).toBeLessThanOrEqual(DATA_MAX_CHARS);
      }
    },
  );

  test('as medidas de pior caso são as medidas fixadas no desenho (margem mínima de 927 caracteres sob 16.000)', () => {
    const measured = Object.fromEntries(
      TYPE_NAMES.map((name) => [
        name,
        ['a', '"'].map((fill) => canonicalLength(worstCase(name, fill))),
      ]),
    );
    expect(measured).toEqual({
      'planner-adr': [7_422, 14_431],
      'architect-review': [5_443, 10_682],
      'critic-findings': [7_629, 14_398],
      'plan-iteration-diff': [9_191, 14_480],
      deviation: [7_984, 15_073],
    });
  });
});

describe('S2/Q3: os cinco tipos contra o servidor real', () => {
  let environment: Environment;

  async function registerBlob(): Promise<string> {
    const put = await environment.call('attachment', {
      project: PROJECT,
      text: 'relatório integral',
    });
    return (put.structuredContent as { hash: string }).hash;
  }

  async function registerEvent(type: string, data: object) {
    return environment.call('register', {
      project: PROJECT,
      process: PROCESS,
      type,
      agent: AGENT,
      data,
    });
  }

  // resultado de cada register_type, para o teste "sem warnings"
  let registrations: { isError?: boolean; warnings: unknown[] }[];

  beforeEach(async () => {
    environment = await createEnvironment();
    await registerCore(environment, PROJECT);
    registrations = [];
    for (const name of TYPE_NAMES) {
      const result = await environment.call('register_type', {
        project: PROJECT,
        name,
        schema: loadSchema(name),
      });
      registrations.push({
        isError: result.isError,
        warnings: (result.structuredContent as { warnings: unknown[] }).warnings,
      });
    }
    await environment.call('create_process', { project: PROJECT, process: PROCESS });
  });

  afterEach(async () => {
    await environment.close();
  });

  test('os cinco tipos registram sem erro e sem warnings', () => {
    expect(registrations).toEqual(TYPE_NAMES.map(() => ({ isError: undefined, warnings: [] })));
  });

  test('create_process fixa os cinco tipos', async () => {
    const list = await environment.call('list', { project: PROJECT, process: PROCESS });
    const { process } = list.structuredContent as { process: { types: { name: string }[] } };
    expect(process.types.map((type) => type.name).sort()).toEqual([...TYPE_NAMES].sort());
  });

  test.each(TYPE_NAMES)('%s: pior caso ×1 e ×2 passa em register', async (name) => {
    const attachment = await registerBlob();
    let supersedes: string[] = [];
    if (name === 'plan-iteration-diff') {
      const first = await registerEvent('planner-adr', { ...minimal('planner-adr'), attachment });
      supersedes = [(first.structuredContent as { id: string }).id];
    }
    for (const fill of ['a', '"']) {
      const data = { ...worstCase(name, fill, supersedes), attachment };
      const result = await registerEvent(name, data);
      expect(result.isError).not.toBe(true);
    }
  });

  test.each(TYPE_NAMES)(
    '%s: campo extra, target inválido e enum inválido → INVALID_EVENT',
    async (name) => {
      const attachment = await registerBlob();
      const valid: Record<string, unknown> = {
        ...minimal(name),
        ...('attachment' in minimal(name) ? { attachment } : {}),
      };
      if (name === 'plan-iteration-diff') {
        const first = await registerEvent('planner-adr', { ...minimal('planner-adr'), attachment });
        valid.supersedes = [(first.structuredContent as { id: string }).id];
      }
      expect((await registerEvent(name, valid)).isError).not.toBe(true);

      expectError(await registerEvent(name, { ...valid, extra: 1 }), 'INVALID_EVENT');
      expectError(await registerEvent(name, { ...valid, target: 'sem-prefixo' }), 'INVALID_EVENT');
      expectError(
        await registerEvent(name, { ...valid, target: 'hex:target:com espaço' }),
        'INVALID_EVENT',
      );
    },
  );

  test('enum fora da escala e relatedEvent fora do formato FULLID → INVALID_EVENT', async () => {
    const attachment = await registerBlob();
    expectError(
      await registerEvent('critic-findings', {
        ...minimal('critic-findings'),
        verdict: 'approve',
        attachment,
      }),
      'INVALID_EVENT',
    );
    expectError(
      await registerEvent('deviation', { ...minimal('deviation'), trigger: 'bug' }),
      'INVALID_EVENT',
    );
    expectError(
      await registerEvent('deviation', { ...minimal('deviation'), relatedEvent: 'nao-e-id' }),
      'INVALID_EVENT',
    );
  });

  test('attempts: [] e findings: [] são válidos', async () => {
    const attachment = await registerBlob();
    expect(
      (await registerEvent('critic-findings', { ...minimal('critic-findings'), attachment }))
        .isError,
    ).not.toBe(true);
    expect((await registerEvent('deviation', minimal('deviation'))).isError).not.toBe(true);
  });

  test('registrar architect-review não altera o state nem o gate no-conflicts', async () => {
    const attachment = await registerBlob();
    await environment.call('register', {
      project: PROJECT,
      process: PROCESS,
      type: 'verdict',
      agent: AGENT,
      data: {
        claim: 'plan-review',
        source: 'critic',
        result: 'ok',
        evidence: 'aprovado',
        target: TARGET,
        origin: 'ralplan',
        trace: 'teste',
      },
    });

    const snapshot = async () => {
      const state = (await environment.call('state', { project: PROJECT, process: PROCESS }))
        .structuredContent as Record<string, unknown> & { chain: { ok: boolean } };
      const gate = await environment.call('evaluate_gate', {
        project: PROJECT,
        process: PROCESS,
        gates: [{ name: 'no-conflicts', target: TARGET }],
        agent: AGENT,
      });
      const { passed } = at(
        (gate.structuredContent as { results: { passed: boolean }[] }).results,
        0,
      );
      return {
        sections: omit(state, ['logThrough', 'now', 'chain']),
        chainOk: state.chain.ok,
        passed,
      };
    };

    const before = await snapshot();
    expect(before.passed).toBe(true);

    const result = await registerEvent('architect-review', {
      ...minimal('architect-review'),
      attachment,
    });
    expect(result.isError).not.toBe(true);

    expect(await snapshot()).toEqual(before);
  });
});

describe('Integração: iteração de ralplan na ordem de chamadas do fork OMC', () => {
  const SLUG = 'hex:target:plano-ralplan';
  const STORY = 'hex:target:historia-1';

  type Entry = {
    type: string;
    id: string;
    result?: string;
    supersededBy?: string[];
    attachment?: { status: string };
  };
  type TimelineBody = {
    entries: Entry[];
    processes: { chain: { ok: boolean } }[];
    warningsTotal: number;
  };

  let environment: Environment;
  let cwd: string;
  let planFile: string;

  beforeEach(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-ralplan-'));
    fs.mkdirSync(path.join(cwd, '.omc', 'plans'), { recursive: true });
    planFile = path.join(cwd, '.omc', 'plans', 'ralplan-x.md');
    environment = await createEnvironment({ cwd });

    await environment.call('register_vocabulary', {
      project: PROJECT,
      owner: 'core',
      milestoneType: ['plan-drafted', 'execution-approval'],
      result: ['approve', 'iterate', 'reject'],
      action: ['follow'],
    });
    for (const name of TYPE_NAMES) {
      await environment.call('register_type', { project: PROJECT, name, schema: loadSchema(name) });
    }
    await environment.call('create_process', { project: PROJECT, process: 'omc-plan' });
    await environment.call('create_process', { project: PROJECT, process: 'omc-exec' });
  });

  afterEach(async () => {
    await environment.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await environment.call(name, args);
    expect(result.isError).not.toBe(true);
    return result.structuredContent as T;
  }

  /** `register` de um evento em `processName`; devolve o id completo. */
  async function register(
    processName: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const receipt = await call<{ id: string }>('register', {
      project: PROJECT,
      process: processName,
      type,
      agent: AGENT,
      data,
    });
    return receipt.id;
  }

  async function putPlan(): Promise<string> {
    const put = await call<{ hash: string }>('attachment', {
      project: PROJECT,
      path: '.omc/plans/ralplan-x.md',
    });
    return put.hash;
  }

  async function putText(text: string): Promise<string> {
    return (await call<{ hash: string }>('attachment', { project: PROJECT, text })).hash;
  }

  function verdict(claim: string, result: string, extra: Record<string, unknown> = {}) {
    return {
      claim,
      source: 'oh-my-claudecode:ralplan',
      result,
      evidence: 'evidência',
      target: SLUG,
      origin: 'ralplan',
      trace: 'teste',
      ...extra,
    };
  }

  test('duas iterações: planner-adr, architect-review, critic-findings, diff, reject seguido de approve', async () => {
    // iteração 1: RG-1 (plano por path) → Step 3 (blob do architect, sem evento) → RG-2 (depois do Critic)
    fs.writeFileSync(planFile, '# Plano v1\n\nDecisão inicial — ação.\n');
    await register('omc-plan', 'milestone', { milestoneType: 'plan-drafted', target: SLUG });
    const adr1 = await register('omc-plan', 'planner-adr', {
      target: SLUG,
      iteration: 1,
      source: 'oh-my-claudecode:planner',
      chosen: 'A',
      why: 'primeira proposta',
      attachment: await putPlan(),
    });
    const architect1 = await putText('Relatório integral do architect, iteração 1 😀');
    const review1 = await register('omc-plan', 'architect-review', {
      target: SLUG,
      iteration: 1,
      source: 'oh-my-claudecode:architect',
      antithesis: 'a',
      tradeoffs: ['t'],
      synthesis: 's',
      verdict: 'revise',
      attachment: architect1,
    });
    const critic1 = await putText('Relatório integral do critic, iteração 1');
    const findings1 = await register('omc-plan', 'critic-findings', {
      target: SLUG,
      iteration: 1,
      source: 'oh-my-claudecode:critic',
      verdict: 'revise',
      justification: 'falta cobertura',
      findings: [{ severity: 'major', finding: 'sem teste', whyItMatters: 'regressão' }],
      attachment: critic1,
    });
    const iterate = await register(
      'omc-plan',
      'verdict',
      verdict('plan-review', 'iterate', { evidence: `${findings1} ${critic1}` }),
    );

    // iteração 2: re-draft com o diff superando o planner-adr anterior (validado pelo servidor)
    fs.writeFileSync(planFile, '# Plano v2\n\nDecisão revisada — ação.\n');
    const plan2 = await putPlan();
    const adr2 = await register('omc-plan', 'planner-adr', {
      target: SLUG,
      iteration: 2,
      source: 'oh-my-claudecode:planner',
      chosen: 'A',
      why: 'segunda proposta',
      attachment: plan2,
    });
    const diff = await register('omc-plan', 'plan-iteration-diff', {
      target: SLUG,
      iteration: 2,
      source: 'oh-my-claudecode:planner',
      changed: [{ change: 'testes', motivatedBy: { finding: 'sem teste', event: findings1 } }],
      supersedes: [adr1],
      attachment: plan2,
    });
    await register('omc-plan', 'architect-review', {
      target: SLUG,
      iteration: 2,
      source: 'oh-my-claudecode:architect',
      antithesis: 'a',
      tradeoffs: ['t'],
      synthesis: 's',
      verdict: 'ok',
      attachment: await putText('Relatório integral do architect, iteração 2'),
    });
    await register('omc-plan', 'critic-findings', {
      target: SLUG,
      iteration: 2,
      source: 'oh-my-claudecode:critic',
      verdict: 'accept',
      justification: 'coberto',
      findings: [],
      attachment: await putText('Relatório integral do critic, iteração 2'),
    });
    await register(
      'omc-plan',
      'verdict',
      verdict('plan-review', 'approve', { supersedes: [iterate] }),
    );

    // RG-9: plano final por path (o mesmo blob da iteração 2) e execution-approval
    expect(await putPlan()).toBe(plan2);
    await register('omc-plan', 'milestone', { milestoneType: 'execution-approval', target: SLUG });

    // RG-5 (B3): reject intermediário de reviewer, deviation, e o approve posterior o supersede
    const rejectId = await register(
      'omc-exec',
      'verdict',
      verdict('completion-verified', 'reject', { target: STORY }),
    );
    await register('omc-exec', 'deviation', {
      target: STORY,
      source: 'oh-my-claudecode:verifier',
      trigger: 'reviewer-reject',
      symptom: 'verifier rejeitou',
      cause: 'teste faltando',
      attempts: [{ action: 'adicionar teste', result: 'passou' }],
      alternatives: [],
      outcome: { status: 'resolved', decidedBy: 'orchestrator', affected: STORY },
      relatedEvent: rejectId,
    });
    await register(
      'omc-exec',
      'verdict',
      verdict('completion-verified', 'approve', { target: STORY, supersedes: [rejectId] }),
    );

    const plan = await call<TimelineBody>('timeline', {
      project: PROJECT,
      targets: [SLUG],
      full: true,
    });
    expect(plan.entries.map((entry) => entry.type)).toEqual([
      'milestone',
      'planner-adr',
      'architect-review',
      'critic-findings',
      'verdict',
      'planner-adr',
      'plan-iteration-diff',
      'architect-review',
      'critic-findings',
      'verdict',
      'milestone',
    ]);
    const byId = Object.fromEntries(plan.entries.map((entry) => [entry.id, entry]));
    expect(byId[adr1]?.supersededBy).toEqual([diff]);
    expect(byId[adr2]?.supersededBy).toBeUndefined();
    expect(byId[iterate]?.supersededBy).toHaveLength(1);
    expect(byId[review1]?.attachment?.status).toBe('ok');
    const attachmentStatuses = plan.entries.flatMap((entry) => entry.attachment?.status ?? []);
    expect(attachmentStatuses).toEqual(attachmentStatuses.map(() => 'ok'));
    expect(attachmentStatuses).toHaveLength(7);
    expect(plan.processes.every((entry) => entry.chain.ok)).toBe(true);
    expect(plan.warningsTotal).toBe(0);

    const story = await call<TimelineBody>('timeline', { project: PROJECT, targets: [STORY] });
    expect(story.entries.map((entry) => [entry.type, entry.result])).toEqual([
      ['verdict', 'reject'],
      ['deviation', undefined],
      ['verdict', 'approve'],
    ]);
    expect(at(story.entries, 0).supersededBy).toHaveLength(1);
    expect(story.warningsTotal).toBe(0);

    // o approve supersedeu o reject: o state só enxerga o approve como vigente
    const state = await call<{ active: { claim: string; status: string }[] }>('state', {
      project: PROJECT,
      process: 'omc-exec',
      sections: ['active'],
    });
    expect(state.active).toEqual([
      expect.objectContaining({ claim: 'completion-verified', status: 'active' }),
    ]);
  });
});
