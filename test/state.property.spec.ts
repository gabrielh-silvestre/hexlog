import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import fc from 'fast-check';
import type { EventLine } from '../src/events.ts';
import { effectiveNow, projectState, type Vocabulary } from '../src/state.ts';

// ---- fixtures locais (duplicadas de state.spec.ts: 2 arquivos só, sem 3º módulo) ----

const T = (n: number) => new Date(n * 60_000).toISOString();
const BASE_NOW = T(0);
const emptyVocabulary: Vocabulary = {
  core: { milestoneType: [], result: [], action: [] },
  byOwner: {},
};

function line(args: {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  seq?: number;
}): EventLine {
  const seqNumber = args.seq ?? 0;
  return {
    seq: seqNumber,
    id: args.id ?? `p:r:${args.type}:${randomUUIDv7()}`,
    type: args.type,
    timestamp: args.timestamp ?? T(seqNumber),
    agent: 'test',
    prevHash: '0'.repeat(64), // sintético: a projeção não verifica hash
    data: args.data,
  };
}

function milestone(
  data: { target: string },
  options: { id?: string; timestamp?: string; seq?: number } = {},
): EventLine {
  return line({
    type: 'milestone',
    data: { milestoneType: 'property-event', ...data },
    ...options,
  });
}

function verdict(
  data: { target: string; claim: string; supersedes?: string[] },
  options: { id?: string; timestamp?: string; seq?: number } = {},
): EventLine {
  return line({
    type: 'verdict',
    data: { source: 'f', evidence: 'p', origin: 'o', trace: 'r', result: 'confirmed', ...data },
    ...options,
  });
}

// ---- gerador de intents (porte de evolve.property.spec.ts:26-67, ids/alvos no formato novo) ----

const TARGET_A = 'hex:target:a';
const TARGET_B = 'hex:target:b';

interface VerdictIntent {
  readonly kind: 'verdict';
  readonly target: string;
  readonly claim: 'a1' | 'a2';
  readonly supersedesOffset: number | null;
}
interface MilestoneIntent {
  readonly kind: 'milestone';
  readonly target: string;
}
type Intent = VerdictIntent | MilestoneIntent;

const intentArbitrary: fc.Arbitrary<Intent> = fc.oneof(
  fc.record({
    kind: fc.constant('verdict' as const),
    target: fc.constantFrom(TARGET_A, TARGET_B),
    claim: fc.constantFrom('a1' as const, 'a2' as const),
    supersedesOffset: fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
  }),
  fc.record({
    kind: fc.constant('milestone' as const),
    target: fc.constantFrom(TARGET_A, TARGET_B),
  }),
);

const sequenceArbitrary = fc.array(intentArbitrary, { minLength: 1, maxLength: 12 });

/** Materializa a sequência de intenções em lines: timestamps crescentes, ids únicos por índice,
 * `supersedes` resolvido só contra verdicts anteriores (nunca referencia algo à frente no log). */
function materialize(intents: readonly Intent[]): EventLine[] {
  const idByIndex: string[] = [];
  const kindByIndex: Intent['kind'][] = [];

  return intents.map((intent, index) => {
    const timestamp = T(index);
    const id = `p:r:${intent.kind}:${randomUUIDv7()}`;
    idByIndex.push(id);
    kindByIndex.push(intent.kind);

    if (intent.kind === 'milestone')
      return milestone({ target: intent.target }, { id, timestamp, seq: index });

    let supersedes: string[] | undefined;
    if (intent.supersedesOffset !== null) {
      const targetIndex = index - intent.supersedesOffset;
      if (targetIndex >= 0 && kindByIndex[targetIndex] === 'verdict')
        supersedes = [idByIndex[targetIndex]];
    }
    return verdict(
      { target: intent.target, claim: intent.claim, supersedes },
      { id, timestamp, seq: index },
    );
  });
}

describe('projectState — propriedades (fast-check)', () => {
  test('para qualquer sequência válida, projectState nunca lança e toda vigência é única ou conflito com 2+ candidatos', () => {
    fc.assert(
      fc.property(sequenceArbitrary, (intents) => {
        const lines = materialize(intents);
        const projection = projectState(lines, emptyVocabulary, effectiveNow(BASE_NOW, lines));

        for (const entry of projection.active) {
          if (entry.status === 'active') expect(entry.active).toBeTruthy();
          else expect(entry.candidates.length).toBeGreaterThanOrEqual(2);
        }
      }),
    );
  });

  test('reinserir ao final uma duplicata de um elo já existente não muda a Projection (idempotência de dedupe)', () => {
    fc.assert(
      fc.property(sequenceArbitrary, fc.nat(), (intents, rawIndex) => {
        const lines = materialize(intents);
        const index = rawIndex % lines.length;
        const duplicate = lines[index];
        const withDuplicate = [...lines, duplicate];
        const now = effectiveNow(BASE_NOW, lines);

        expect(projectState(withDuplicate, emptyVocabulary, now)).toEqual(
          projectState(lines, emptyVocabulary, now),
        );
      }),
    );
  });

  test('vigentes aparece na ordem de 1ª aparição da chave (target, claim) no log', () => {
    fc.assert(
      fc.property(sequenceArbitrary, (intents) => {
        const lines = materialize(intents);
        const projection = projectState(lines, emptyVocabulary, effectiveNow(BASE_NOW, lines));

        const logOrder: string[] = [];
        for (const e of lines) {
          if (e.type !== 'verdict') continue;
          const data = e.data as { target: string; claim: string };
          const key = JSON.stringify([data.target, data.claim]);
          if (!logOrder.includes(key)) logOrder.push(key);
        }

        const obtainedOrder = projection.active.map((v) => JSON.stringify([v.target, v.claim]));
        // grupos inteiramente superados por outra chave somem de active (não fundem, só desaparecem):
        // a ordem relativa entre as chaves que sobraram é a propriedade garantida.
        expect(obtainedOrder).toEqual(logOrder.filter((key) => obtainedOrder.includes(key)));
      }),
    );
  });
});
