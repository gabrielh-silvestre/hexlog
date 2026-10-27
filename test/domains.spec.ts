import { describe, expect, it } from '@jest/globals';
import type { Gate } from '../src/domain/definitions.ts';
import { note, refusal } from './commands/register-fakes.ts';
import * as omc from './fixtures/domains/omc.ts';
import * as rdsc from './fixtures/domains/rdsc.ts';
import { at, idsOf } from './helpers.ts';
import { PROJECT, querySetup, defineDomain, type Domain } from './queries/query-setup.ts';

/**
 * Projeto só com o fluxo `domain`, definido pelo serviço de definições e com o processo `run-1`
 * criado; `legacy` cria o processo sem a herança de relações pela linhagem.
 */
function flowSetup(domain: Domain, { legacy = false } = {}) {
  const setup = querySetup({ defaults: false });
  defineDomain(setup.definitions, domain);
  if (legacy) setup.createLegacyProcess('run-1');
  else setup.createProcess('run-1');
  const gate = (name: string) =>
    setup.queries.evaluateGate({ project: PROJECT, process: 'run-1', gate: name });
  return { ...setup, gate };
}

/** Cópia do gate plano-pronto com as perguntas em alcance projeto. */
const READY_PROJECT: Gate = {
  name: 'plan-ready-project',
  questions: at(omc.gates, 0).questions.map((question) => ({
    ...question,
    scope: 'project' as const,
  })),
};

describe('test/fixtures/domains/*.ts', () => {
  it('should export only data: types, relations and gates for each flow', () => {
    expect(Object.keys(omc).sort()).toEqual(['gates', 'relations', 'types']);
    expect(Object.keys(rdsc).sort()).toEqual(['gates', 'relations', 'types']);
  });
});

/** Fluxo OMC com o plano `plan` registrado no processo `run-1`. */
async function registeredPlan() {
  const setup = flowSetup({ ...omc, gates: [...omc.gates, READY_PROJECT] });
  const plan = await setup.registerOne('run-1', {
    type: 'plan',
    target: 'run.plan',
    data: { isRevision: false },
  });
  return { ...setup, plan };
}

/** O plano aprovado por `review`, com o desvio `deviation` ainda pendente. */
async function planWithPendingDeviation() {
  const setup = await registeredPlan();
  const review = await setup.registerOne(
    'run-1',
    {
      type: 'review',
      target: 'run.plan',
      data: { summary: 'ok' },
      relations: [{ to: setup.plan, as: 'approves' }],
    },
    1,
  );
  const deviation = await setup.registerOne(
    'run-1',
    { type: 'deviation', target: 'run.plan', data: { description: 'outside the plan' } },
    2,
  );
  return { ...setup, review, deviation };
}

/** O plano aprovado, com o desvio resolvido por uma segunda revisão que o `settles`. */
async function settledPlan() {
  const setup = await planWithPendingDeviation();
  await setup.registerOne(
    'run-1',
    {
      type: 'review',
      target: 'run.plan',
      data: { summary: 'accepted' },
      relations: [{ to: setup.deviation, as: 'settles' }],
    },
    3,
  );
  return setup;
}

/** Fluxo rdsc com processo legado: o veredito `verdict` cita a evidência `old`. */
async function verdictOnEvidence() {
  const setup = flowSetup(rdsc, { legacy: true });
  const old = await setup.registerOne('run-1', {
    type: 'evidence',
    target: 'run.rdsc',
    data: { source: 'a' },
  });
  const verdict = await setup.registerOne(
    'run-1',
    {
      type: 'verdict',
      target: 'run.rdsc',
      data: { conclusion: 'upheld' },
      relations: [{ to: old, as: 'based-on' }],
    },
    1,
  );
  return { ...setup, old, verdict };
}

/** O veredito `verdict` renovado (`renewed`) sobre a evidência nova `fresh`, que substitui `old`. */
async function renewedVerdict() {
  const setup = await verdictOnEvidence();
  const fresh = await setup.registerOne(
    'run-1',
    {
      type: 'evidence',
      target: 'run.rdsc',
      data: { source: 'b' },
      relations: [{ to: setup.old, as: 'replaces' }],
    },
    2,
  );
  const renewed = await setup.registerOne(
    'run-1',
    {
      type: 'verdict',
      target: 'run.rdsc',
      data: { conclusion: 'upheld, with the new evidence' },
      relations: [
        { to: setup.verdict, as: 'replaces' },
        { to: fresh, as: 'based-on' },
      ],
    },
    3,
  );
  return { ...setup, fresh, renewed };
}

describe('QueryService.evaluateGate', () => {
  it('should fail the OMC plan-ready gate for a plan with no approval', async () => {
    const { gate } = await registeredPlan();

    expect(gate('plan-ready').passed).toBe(false);
  });

  it('should fail the OMC plan-ready gate for an approved plan with a pending deviation', async () => {
    const { gate } = await planWithPendingDeviation();

    expect(gate('plan-ready').questions.map(({ passed }) => passed)).toEqual([true, false]);
  });

  it('should pass the OMC plan-ready gate with a current approval and no pending deviation', async () => {
    const { gate } = await settledPlan();

    expect(gate('plan-ready').passed).toBe(true);
  });

  it('should pass the OMC plan-ready gate with scope project when the approval and the outcome come from another process', async () => {
    const { createProcess, registerOne, gate, plan } = await registeredPlan();
    createProcess('review-1');
    const open = await registerOne(
      'run-1',
      { type: 'deviation', target: 'run.plan', data: { description: 'desvio' } },
      1,
    );
    await registerOne(
      'review-1',
      {
        type: 'review',
        target: 'run.plan',
        data: { summary: 'ok' },
        relations: [{ to: plan, as: 'approves' }],
      },
      2,
    );
    await registerOne(
      'review-1',
      {
        type: 'review',
        target: 'run.plan',
        data: { summary: 'resolvido' },
        relations: [{ to: open, as: 'settles' }],
      },
      3,
    );

    expect(gate('plan-ready').passed).toBe(false);
    expect(gate(READY_PROJECT.name).passed).toBe(true);
  });

  describe('with the rdsc flow and a legacy process', () => {
    it('should pass the settled gate for a verdict that cites current evidence', async () => {
      const { gate } = await verdictOnEvidence();

      expect(gate('settled').passed).toBe(true);
    });

    it('should keep the settled gate passing once the verdict is renewed on new evidence', async () => {
      const { gate } = await renewedVerdict();

      expect(gate('settled').passed).toBe(true);
    });
  });
});

describe('QueryService.queryRecords', () => {
  it('should link the approving review to the plan through the approves relation', async () => {
    const { query, plan, review } = await settledPlan();

    expect(query({ process: 'run-1', ids: [plan] }).records).toMatchObject([
      { in: [{ kind: 'supports', as: 'approves', from: review, current: true }] },
    ]);
  });

  it('should flag a verdict that cites superseded evidence as needing review, in the rdsc flow with a legacy process', async () => {
    const { registerOne, query, old, verdict } = await verdictOnEvidence();
    await registerOne(
      'run-1',
      {
        type: 'evidence',
        target: 'run.rdsc',
        data: { source: 'b' },
        relations: [{ to: old, as: 'replaces' }],
      },
      2,
    );

    expect(query({ process: 'run-1', ids: [verdict] }).records).toMatchObject([
      { needsReview: { staleIn: [], staleOut: [old] } },
    ]);
  });

  it('should list only the renewed verdict as current, in the rdsc flow with a legacy process', async () => {
    const { query, renewed } = await renewedVerdict();

    expect(idsOf(query({ process: 'run-1', type: 'verdict' }))).toEqual([renewed]);
  });

  it('should stop flagging a verdict once the new version cites the current evidence, in the rdsc flow with a legacy process', async () => {
    const { query } = await renewedVerdict();

    const current = query({ process: 'run-1', type: 'verdict' });

    expect(at(current.records, 0).needsReview).toBeUndefined();
  });
});

describe('ProcessService.register', () => {
  it('should refuse a plan revision without a diff at write time by the type schema', async () => {
    const { registerOne, plan } = await registeredPlan();

    const error = await refusal(
      registerOne(
        'run-1',
        {
          type: 'plan',
          target: 'run.plan',
          data: { isRevision: true },
          relations: [{ to: plan, kind: 'supersedes' }],
        },
        1,
      ),
    );

    expect(error.code).toBe('INVALID_RECORD');
  });

  it('should refuse with TYPE_NOT_PINNED a type the flow did not define', async () => {
    const { registerOne } = flowSetup(rdsc);

    await expect(registerOne('run-1', note('x'))).rejects.toMatchObject({
      code: 'TYPE_NOT_PINNED',
    });
  });
});
