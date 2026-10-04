import fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import type { Gate } from '../../src/domain/definitions.ts';
import type { Marker } from '../../src/domain/ids.ts';
import { GateQuestion } from '../../src/domain/gate.ts';
import type { EvaluateGateInput } from '../../src/queries/query-service.ts';
import { NOTE, note, refusal } from '../commands/register-fakes.ts';
import * as omc from '../fixtures/domains/omc.ts';
import { captureError } from '../helpers.ts';
import { defineDomain, PROJECT, querySetup } from './query-setup.ts';

type Extra = Pick<EvaluateGateInput, 'target' | 'marker'>;

/** Projeto com `note`, `doc` e `finding`, mais os gates, definidos antes de qualquer `createProcess`. */
function gateSetup(...gates: Gate[]) {
  const setup = querySetup();
  setup.definitions.write(PROJECT, 'types', 'finding', '1.0', NOTE);
  for (const gate of gates) setup.definitions.write(PROJECT, 'gates', gate.name, '1.0', gate);
  const evaluate = (process: string, gate: string, extra: Extra = {}) =>
    setup.queries.evaluateGate({ project: PROJECT, process, gate, ...extra });
  return { ...setup, evaluate };
}

const PROPOSED: Gate = {
  name: 'proposed-approved',
  questions: [{ kind: 'approved', of: { type: 'note', where: { text: 'proposta' } } }],
};

describe('evaluateGate: marcador e nomes herdados', () => {
  test('alcance processo: marcador sem a entrada do processo lido é MARKER_NOT_FOUND em /marker, não vacuidade', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    const head = await registerOne('run-1', note('proposta'));

    const malformed: Marker[] = [{}, { 'run-2': null }, { 'run-1': head, 'run-2': null }];
    for (const marker of malformed) {
      const error = captureError(() => evaluate('run-1', PROPOSED.name, { marker }));
      expect(error.code).toBe('MARKER_NOT_FOUND');
      expect(error.details).toEqual([
        expect.objectContaining({ path: '/marker', code: 'process-not-found' }),
      ]);
    }
    expect(evaluate('run-1', PROPOSED.name, { marker: { 'run-1': null } }).marker).toEqual({
      'run-1': null,
    });
  });

  test('gate chamado `constructor` e não fixado é GATE_NOT_FOUND, não INTERNAL', () => {
    const { createProcess, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');

    const error = captureError(() => evaluate('run-1', 'constructor'));

    expect(error.code).toBe('GATE_NOT_FOUND');
  });
});

describe('evaluateGate: não grava, marcador e reprodução', () => {
  test('avaliar o gate não grava: o log fica byte a byte igual', async () => {
    const { logPath, createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    await registerOne('run-1', note('proposta'));
    const before = fs.readFileSync(logPath('run-1'));

    evaluate('run-1', PROPOSED.name);
    evaluate('run-1', PROPOSED.name);

    expect(fs.readFileSync(logPath('run-1')).equals(before)).toBe(true);
  });

  test('o marcador cobre só o processo da chamada, mesmo com outros no projeto', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    createProcess('run-2');
    const head = await registerOne('run-1', note('proposta'));
    await registerOne('run-2', note('outra'));

    expect(evaluate('run-1', PROPOSED.name).marker).toEqual({ 'run-1': head });
  });

  test('o marcador de pergunta com scope project cobre todos os processos lidos, o vazio como null', async () => {
    const wide: Gate = {
      name: 'wide',
      questions: [{ kind: 'occurred', select: { type: 'note' }, scope: 'project' }],
    };
    const { createProcess, registerOne, evaluate } = gateSetup(wide);
    createProcess('run-1');
    createProcess('run-2');
    const head = await registerOne('run-1', note('a'));

    expect(evaluate('run-1', 'wide').marker).toEqual({ 'run-1': head, 'run-2': null });
  });

  test('a reprodução com marcador dá o resultado de antes, mesmo com registro novo que mudaria a resposta', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    const proposal = await registerOne('run-1', note('proposta'));
    await registerOne(
      'run-1',
      note('aprovação', { relations: [{ to: proposal, kind: 'supports' }] }),
      1,
    );
    const before = evaluate('run-1', PROPOSED.name);
    await registerOne('run-1', note('proposta'), 2);

    expect(before.passed).toBe(true);
    expect(evaluate('run-1', PROPOSED.name).passed).toBe(false);
    expect(evaluate('run-1', PROPOSED.name, { marker: before.marker })).toEqual(before);
  });

  test('a reprodução no alcance projeto lê o processo que nasceu depois como vazio', async () => {
    const wide: Gate = {
      name: 'wide-approved',
      questions: [{ ...PROPOSED.questions[0]!, scope: 'project' }],
    };
    const { createProcess, registerOne, evaluate } = gateSetup(wide);
    createProcess('run-1');
    const proposal = await registerOne('run-1', note('proposta'));
    await registerOne(
      'run-1',
      note('aprovação', { relations: [{ to: proposal, kind: 'supports' }] }),
      1,
    );
    const before = evaluate('run-1', 'wide-approved');
    createProcess('run-2');
    await registerOne('run-2', note('proposta'), 2);

    expect(evaluate('run-1', 'wide-approved').passed).toBe(false);
    const replayed = evaluate('run-1', 'wide-approved', { marker: before.marker });
    expect(replayed.passed).toBe(true);
    expect(replayed.marker).toEqual({ ...before.marker, 'run-2': null });
  });
});

describe('evaluateGate: as quatro perguntas', () => {
  test('approved: aprova com apoio do `by`, e aponta o sem apoio e a contradição', async () => {
    const gate: Gate = {
      name: 'ap',
      questions: [
        {
          kind: 'approved',
          of: { type: 'note', where: { text: 'proposta' } },
          by: { type: 'doc' },
        },
      ],
    };
    const { createProcess, registerOne, evaluate } = gateSetup(gate);
    createProcess('run-1');
    const proposal = await registerOne('run-1', note('proposta'));
    await registerOne(
      'run-1',
      note('apoio de tipo errado', { relations: [{ to: proposal, kind: 'supports' }] }),
      1,
    );

    const [unsupported] = evaluate('run-1', 'ap').questions;
    expect(unsupported).toMatchObject({
      kind: 'approved',
      passed: false,
      evidence: { of: [proposal], supports: [], unsupported: [proposal] },
    });

    const support = await registerOne(
      'run-1',
      {
        type: 'doc',
        target: 'run.step',
        data: {},
        relations: [{ to: proposal, kind: 'supports' }],
      },
      2,
    );
    expect(evaluate('run-1', 'ap').questions[0]).toMatchObject({
      passed: true,
      evidence: { supports: [support], unsupported: [], contradictions: [] },
    });

    const rejection = await registerOne(
      'run-1',
      note('recusa', { relations: [{ to: proposal, kind: 'contradicts' }] }),
      3,
    );
    expect(evaluate('run-1', 'ap').questions[0]).toMatchObject({
      passed: false,
      evidence: { contradictions: [rejection] },
    });
  });

  test('occurred: `min` e os seletores `type`, `where` escalar e `targetPrefix` próprio', async () => {
    const gate: Gate = {
      name: 'occ',
      questions: [
        { kind: 'occurred', select: { type: 'note', where: { text: 'x' } }, min: 2 },
        { kind: 'occurred', select: { targetPrefix: 'other' } },
      ],
    };
    const { createProcess, registerOne, evaluate } = gateSetup(gate);
    createProcess('run-1');
    await registerOne('run-1', note('x', { target: 'run.a' }));
    await registerOne('run-1', note('y', { target: 'run.a' }), 1);
    const second = await registerOne('run-1', note('x', { target: 'other.b' }), 2);

    const result = evaluate('run-1', 'occ', { target: 'run' });

    expect(result.passed).toBe(false);
    expect(result.questions[0]).toMatchObject({ passed: false });
    expect(result.questions[1]).toMatchObject({ passed: true, evidence: { found: [second] } });
  });

  test('o targetPrefix omitido herda o `target` da chamada', async () => {
    const gate: Gate = { name: 'inh', questions: [{ kind: 'occurred', select: { type: 'note' } }] };
    const { createProcess, registerOne, evaluate } = gateSetup(gate);
    createProcess('run-1');
    const inside = await registerOne('run-1', note('a', { target: 'run.a' }));
    const sibling = await registerOne('run-1', note('b', { target: 'run.ab' }), 1);

    expect(evaluate('run-1', 'inh', { target: 'run.a' }).questions[0]).toMatchObject({
      evidence: { found: [inside] },
    });
    expect(evaluate('run-1', 'inh').questions[0]).toMatchObject({
      evidence: { found: [inside, sibling] },
    });
  });

  test('no_pending: reprova apontando o pendente sem desfecho do `from` pedido', async () => {
    const gate: Gate = {
      name: 'pend',
      questions: [
        {
          kind: 'no_pending',
          pending: { type: 'finding' },
          resolvedBy: { kind: 'answers', from: ['note'] },
        },
      ],
    };
    const { createProcess, registerOne, evaluate } = gateSetup(gate);
    createProcess('run-1');
    const open = await registerOne('run-1', {
      type: 'finding',
      target: 'run.a',
      data: { text: 'a' },
    });
    const wrongType = await registerOne(
      'run-1',
      { type: 'finding', target: 'run.b', data: { text: 'b' } },
      1,
    );
    await registerOne(
      'run-1',
      { type: 'doc', target: 'run.b', data: {}, relations: [{ to: wrongType, kind: 'answers' }] },
      2,
    );

    expect(evaluate('run-1', 'pend').questions[0]).toMatchObject({
      passed: false,
      evidence: { unresolved: [open, wrongType] },
    });

    await registerOne('run-1', note('a', { relations: [{ to: open, kind: 'answers' }] }), 3);
    await registerOne('run-1', note('b', { relations: [{ to: wrongType, kind: 'answers' }] }), 4);
    expect(evaluate('run-1', 'pend').passed).toBe(true);
  });

  test('no_open_contradiction: aponta o registro contradito e passa quando o contraditor é substituído', async () => {
    const gate: Gate = { name: 'clash', questions: [{ kind: 'no_open_contradiction' }] };
    const { createProcess, registerOne, evaluate } = gateSetup(gate);
    createProcess('run-1');
    const claim = await registerOne('run-1', note('afirmação'));
    const attack = await registerOne(
      'run-1',
      note('ataque', { relations: [{ to: claim, kind: 'contradicts' }] }),
      1,
    );

    expect(evaluate('run-1', 'clash').questions[0]).toMatchObject({
      passed: false,
      evidence: { conflicting: [claim] },
    });

    await registerOne(
      'run-1',
      {
        type: 'note',
        target: 'run.step',
        data: { text: 'ataque retirado' },
        relations: [{ to: attack, kind: 'revokes' }],
      },
      2,
    );
    expect(evaluate('run-1', 'clash').passed).toBe(true);
  });

  test('o scope por pergunta: a aprovação de outro processo só conta com scope project', async () => {
    const gate = (scope: 'process' | 'project'): Gate => ({
      name: `cross-${scope}`,
      questions: [{ kind: 'approved', of: { type: 'note', where: { text: 'proposta' } }, scope }],
    });
    const { createProcess, registerOne, evaluate } = gateSetup(gate('process'), gate('project'));
    createProcess('run-1');
    createProcess('run-2');
    const proposal = await registerOne('run-1', note('proposta'));
    await registerOne(
      'run-2',
      note('aprovação', { relations: [{ to: proposal, kind: 'supports' }] }),
      1,
    );

    expect(evaluate('run-1', 'cross-process').passed).toBe(false);
    expect(evaluate('run-1', 'cross-project').passed).toBe(true);
  });

  test('gate inexistente é GATE_NOT_FOUND e processo inexistente é PROCESS_NOT_FOUND', () => {
    const { createProcess, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');

    const gate = captureError(() => evaluate('run-1', 'nope'));
    const process = captureError(() => evaluate('ghost', PROPOSED.name));

    expect(gate.code).toBe('GATE_NOT_FOUND');
    expect(gate.details[0]).toMatchObject({ path: '/gate', code: 'unknown-name' });
    expect(process.code).toBe('PROCESS_NOT_FOUND');
  });
});

describe('evaluateGate: higiene da cadeia', () => {
  test('higiene: a cadeia é verificada sempre e quebra dá PROCESS_CORRUPTED nomeando o processo', async () => {
    const { createProcess, registerOne, tamper, evaluate } = gateSetup(PROPOSED);
    createProcess('run-1');
    await registerOne('run-1', note('proposta'));
    await registerOne('run-1', note('seguinte'), 1);
    tamper('run-1');

    const error = captureError(() => evaluate('run-1', PROPOSED.name));

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(error.details[0]).toMatchObject({ code: 'broken-chain', process: 'run-1' });
  });

  test('higiene: pergunta de alcance projeto falha fechado com o processo quebrado, não o da chamada', async () => {
    const wide: Gate = {
      name: 'wide-hygiene',
      questions: [{ kind: 'occurred', select: { type: 'note' }, scope: 'project' }],
    };
    const { createProcess, registerOne, tamper, evaluate } = gateSetup(wide);
    createProcess('run-1');
    createProcess('run-2');
    await registerOne('run-1', note('a'));
    await registerOne('run-2', note('b'), 1);
    await registerOne('run-2', note('c'), 2);
    tamper('run-2');

    const error = captureError(() => evaluate('run-1', 'wide-hygiene'));

    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(error.details[0]).toMatchObject({ process: 'run-2' });
  });

  test('higiene: "sem bifurcação" não existe como pergunta de gate', () => {
    expect(GateQuestion.safeParse({ kind: 'no_fork' }).success).toBe(false);
  });
});

/** Gate plano-pronto de 4.1 (`test/fixtures/domains/omc.ts`) e uma cópia com as perguntas em alcance projeto. */
const READY = omc.gates[0]!;
const READY_PROJECT: Gate = {
  name: 'plan-ready-project',
  questions: READY.questions.map((question) => ({ ...question, scope: 'project' as const })),
};

function planSetup() {
  const setup = querySetup({ defaults: false });
  defineDomain(setup.definitions, {
    ...omc,
    gates: [READY, READY_PROJECT],
  });
  const plan = (extra = {}) => ({
    type: 'plan',
    target: 'run.plan',
    data: { isRevision: false },
    ...extra,
  });
  const approves = (to: string, extra = {}) => ({
    type: 'review',
    target: 'run.plan',
    data: { summary: 'ok' },
    relations: [{ to, as: 'approves' }],
    ...extra,
  });
  const deviation = { type: 'deviation', target: 'run.plan', data: { description: 'desvio' } };
  const settles = (to: string) => ({
    type: 'review',
    target: 'run.plan',
    data: { summary: 'resolvido' },
    relations: [{ to, as: 'settles' }],
  });
  const ready = (process: string, gate = READY.name) =>
    setup.queries.evaluateGate({ project: PROJECT, process, gate });
  return { ...setup, plan, approves, deviation, settles, ready };
}

describe('D4: gate plano-pronto', () => {
  test('plano-pronto: plano sem aprovação reprova e com aprovação e sem desvio passa', async () => {
    const { createProcess, registerOne, plan, approves, ready } = planSetup();
    createProcess('run-1');
    const first = await registerOne('run-1', plan());

    expect(ready('run-1').questions[0]).toMatchObject({
      passed: false,
      evidence: { of: [first], unsupported: [first] },
    });

    await registerOne('run-1', approves(first), 1);
    expect(ready('run-1').passed).toBe(true);
  });

  test('plano-pronto: só a revisão vigente conta, a aprovação da revisão substituída não vale', async () => {
    const { createProcess, registerOne, plan, approves, ready } = planSetup();
    createProcess('run-1');
    const first = await registerOne('run-1', plan());
    await registerOne('run-1', approves(first), 1);
    const second = await registerOne(
      'run-1',
      plan({
        data: { isRevision: true, diff: 'trocou o passo 2' },
        relations: [{ to: first, kind: 'supersedes' }],
      }),
      2,
    );

    expect(ready('run-1').questions[0]).toMatchObject({
      passed: false,
      evidence: { of: [second], unsupported: [second] },
    });

    await registerOne('run-1', approves(second), 3);
    expect(ready('run-1').passed).toBe(true);
  });

  test('plano-pronto: revisão de plano sem diff é recusada na gravação pelo schema do tipo', async () => {
    const { createProcess, registerOne, plan } = planSetup();
    createProcess('run-1');
    const first = await registerOne('run-1', plan());

    const error = await refusal(
      registerOne(
        'run-1',
        plan({ data: { isRevision: true }, relations: [{ to: first, kind: 'supersedes' }] }),
        1,
      ),
    );

    expect(error.code).toBe('INVALID_RECORD');
  });

  test('plano-pronto: desvio sem desfecho reprova e o desfecho (`settles`) libera', async () => {
    const { createProcess, registerOne, plan, approves, deviation, settles, ready } = planSetup();
    createProcess('run-1');
    const first = await registerOne('run-1', plan());
    await registerOne('run-1', approves(first), 1);
    const open = await registerOne('run-1', deviation, 2);

    expect(ready('run-1').questions[1]).toMatchObject({
      kind: 'no_pending',
      passed: false,
      evidence: { unresolved: [open] },
    });

    await registerOne('run-1', settles(open), 3);
    expect(ready('run-1').passed).toBe(true);
  });

  test('plano-pronto: com scope project a aprovação e o desfecho vêm de outro processo', async () => {
    const { createProcess, registerOne, plan, approves, deviation, settles, ready } = planSetup();
    createProcess('run-1');
    createProcess('review-1');
    const first = await registerOne('run-1', plan());
    const open = await registerOne('run-1', deviation, 1);
    await registerOne('review-1', approves(first), 2);
    await registerOne('review-1', settles(open), 3);

    expect(ready('run-1').passed).toBe(false);
    expect(ready('run-1', READY_PROJECT.name).passed).toBe(true);
  });
});

describe('D5 e SG4: gate de achados e previstos', () => {
  const answered: Gate = {
    name: 'all-answered',
    questions: [
      { kind: 'no_pending', pending: { type: 'finding' }, resolvedBy: { kind: 'answers' } },
    ],
  };

  test('achado: reprova quando um achado não tem `answers` de entrada e passa quando todos têm', async () => {
    const { createProcess, registerOne, evaluate } = gateSetup(answered);
    createProcess('run-1');
    const answeredFinding = await registerOne('run-1', {
      type: 'finding',
      target: 'run.a',
      data: { text: 'a' },
    });
    const openFinding = await registerOne(
      'run-1',
      { type: 'finding', target: 'run.b', data: { text: 'b' } },
      1,
    );
    await registerOne(
      'run-1',
      note('resposta a', { relations: [{ to: answeredFinding, kind: 'answers' }] }),
      2,
    );

    expect(evaluate('run-1', 'all-answered').questions[0]).toMatchObject({
      passed: false,
      evidence: { unresolved: [openFinding] },
    });

    await registerOne(
      'run-1',
      note('resposta b', { relations: [{ to: openFinding, kind: 'answers' }] }),
      3,
    );
    expect(evaluate('run-1', 'all-answered').passed).toBe(true);
  });

  test('previsto: todo previsto do tipo X no alvo Y precisa de feito, e o gate aponta o previsto sem feito', async () => {
    const planned: Gate = {
      name: 'planned-done',
      questions: [
        {
          kind: 'no_pending',
          pending: { type: 'finding', targetPrefix: 'run.step' },
          resolvedBy: { kind: 'derivesFrom', from: ['note'] },
        },
      ],
    };
    const { createProcess, registerOne, evaluate } = gateSetup(planned);
    createProcess('run-1');
    const done = await registerOne('run-1', {
      type: 'finding',
      target: 'run.step.one',
      data: { text: 'a' },
    });
    const missing = await registerOne(
      'run-1',
      { type: 'finding', target: 'run.step.two', data: { text: 'b' } },
      1,
    );
    await registerOne(
      'run-1',
      { type: 'finding', target: 'run.elsewhere', data: { text: 'c' } },
      2,
    );
    await registerOne(
      'run-1',
      note('feito', { relations: [{ to: done, kind: 'derivesFrom' }] }),
      3,
    );

    expect(evaluate('run-1', 'planned-done').questions[0]).toMatchObject({
      passed: false,
      evidence: { unresolved: [missing] },
    });
  });
});
