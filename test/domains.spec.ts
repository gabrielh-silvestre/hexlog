import { describe, expect, test } from '@jest/globals';
import { note } from './commands/register-fakes.ts';
import * as omc from './fixtures/domains/omc.ts';
import * as rdsc from './fixtures/domains/rdsc.ts';
import { idsOf, PROJECT, querySetup, defineDomain, type Domain } from './queries/query-setup.ts';

/** Projeto só com o fluxo `domain`, definido pelo serviço de definições e com o processo `run-1` criado. */
function flowSetup(domain: Domain) {
  const setup = querySetup({ defaults: false });
  defineDomain(setup.definitions, domain);
  setup.createProcess('run-1');
  const gate = (name: string) =>
    setup.queries.evaluateGate({ project: PROJECT, process: 'run-1', gate: name });
  return { ...setup, gate };
}

describe('D2: fluxos configurados só por tipos, nomes de relação e gates', () => {
  test('cada fluxo exporta apenas dado: types, relations e gates', () => {
    expect(Object.keys(omc).sort()).toEqual(['gates', 'relations', 'types']);
    expect(Object.keys(rdsc).sort()).toEqual(['gates', 'relations', 'types']);
  });

  test('fluxo OMC: o plano só está pronto com aprovação vigente e sem desvio pendente', async () => {
    const { registerOne, gate, query } = flowSetup(omc);
    const plan = await registerOne('run-1', {
      type: 'plan',
      target: 'run.plan',
      data: { isRevision: false },
    });
    expect(gate('plan-ready').passed).toBe(false);

    const review = await registerOne(
      'run-1',
      {
        type: 'review',
        target: 'run.plan',
        data: { summary: 'ok' },
        relations: [{ to: plan, as: 'approves' }],
      },
      1,
    );
    const deviation = await registerOne(
      'run-1',
      { type: 'deviation', target: 'run.plan', data: { description: 'fora do plano' } },
      2,
    );
    expect(gate('plan-ready').questions.map(({ passed }) => passed)).toEqual([true, false]);

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

  test('fluxo rdsc: veredito vigente que cita evidência substituída pede revisão até a nova versão citar a atual', async () => {
    const { registerOne, gate, query } = flowSetup(rdsc);
    const old = await registerOne('run-1', {
      type: 'evidence',
      target: 'run.rdsc',
      data: { source: 'a' },
    });
    const verdict = await registerOne(
      'run-1',
      {
        type: 'verdict',
        target: 'run.rdsc',
        data: { conclusion: 'procede' },
        relations: [{ to: old, as: 'based-on' }],
      },
      1,
    );
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
    expect(query({ process: 'run-1', ids: [verdict] }).records[0]?.needsReview).toEqual({
      staleIn: [],
      staleOut: [old],
    });

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

  test('tipo que o fluxo não definiu não está fixado no processo (TYPE_NOT_PINNED)', async () => {
    const { registerOne } = flowSetup(rdsc);

    await expect(registerOne('run-1', note('x'))).rejects.toMatchObject({
      code: 'TYPE_NOT_PINNED',
    });
  });
});
