import { describe, expect, it } from '@jest/globals';
import { note } from './commands/register-fakes.ts';
import * as omc from './fixtures/domains/omc.ts';
import * as rdsc from './fixtures/domains/rdsc.ts';
import { idsOf, PROJECT, querySetup, defineDomain, type Domain } from './queries/query-setup.ts';

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

describe('test/fixtures/domains/*.ts', () => {
  it('should export only data: types, relations and gates for each flow', () => {
    expect(Object.keys(omc).sort()).toEqual(['gates', 'relations', 'types']);
    expect(Object.keys(rdsc).sort()).toEqual(['gates', 'relations', 'types']);
  });
});

/** Fluxo OMC com o plano `plan` registrado no processo `run-1`. */
async function registeredPlan() {
  const setup = flowSetup(omc);
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
    { type: 'deviation', target: 'run.plan', data: { description: 'fora do plano' } },
    2,
  );
  return { ...setup, review, deviation };
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
    const { registerOne, gate, query, plan, review, deviation } = await planWithPendingDeviation();
    await registerOne(
      'run-1',
      {
        type: 'review',
        target: 'run.plan',
        data: { summary: 'aceito' },
        relations: [{ to: deviation, as: 'settles' }],
      },
      3,
    );

    expect(gate('plan-ready').passed).toBe(true);
    expect(query({ process: 'run-1', ids: [plan] }).records[0]?.in).toEqual([
      { kind: 'supports', as: 'approves', from: review, current: true },
    ]);
  });
});

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
      data: { conclusion: 'procede' },
      relations: [{ to: old, as: 'based-on' }],
    },
    1,
  );
  return { ...setup, old, verdict };
}

describe('QueryService.queryRecords', () => {
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

    expect(query({ process: 'run-1', ids: [verdict] }).records[0]?.needsReview).toEqual({
      staleIn: [],
      staleOut: [old],
    });
  });

  it('should stop flagging a verdict once the new version cites the current evidence, in the rdsc flow with a legacy process', async () => {
    const { registerOne, gate, query, old, verdict } = await verdictOnEvidence();

    expect(gate('settled').passed).toBe(true);

    const fresh = await registerOne(
      'run-1',
      {
        type: 'evidence',
        target: 'run.rdsc',
        data: { source: 'b' },
        relations: [{ to: old, as: 'replaces' }],
      },
      2,
    );
    const renewed = await registerOne(
      'run-1',
      {
        type: 'verdict',
        target: 'run.rdsc',
        data: { conclusion: 'procede, com a evidência nova' },
        relations: [
          { to: verdict, as: 'replaces' },
          { to: fresh, as: 'based-on' },
        ],
      },
      3,
    );
    const current = query({ process: 'run-1', type: 'verdict' });

    expect(idsOf(current)).toEqual([renewed]);
    expect(current.records[0]?.needsReview).toBeUndefined();
    expect(gate('settled').passed).toBe(true);
  });
});

describe('ProcessService.register', () => {
  it('should refuse with TYPE_NOT_PINNED a type the flow did not define', async () => {
    const { registerOne } = flowSetup(rdsc);

    await expect(registerOne('run-1', note('x'))).rejects.toMatchObject({
      code: 'TYPE_NOT_PINNED',
    });
  });
});
