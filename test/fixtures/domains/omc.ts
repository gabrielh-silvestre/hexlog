import type { Gate, RecordType, RelationName } from '../../../src/domain/definitions.ts';

/**
 * Fluxo OMC (4.1, gate plano-pronto): tipo único `plan`, em que a revisão N `supersedes` a N-1.
 * O schema exige `diff` quando `isRevision` é `true`; o gate cobra só a revisão vigente.
 */
export const types = {
  plan: {
    type: 'object',
    properties: { isRevision: { type: 'boolean' }, diff: { type: 'string' } },
    required: ['isRevision'],
    if: { properties: { isRevision: { const: true } } },
    then: { properties: { diff: { type: 'string' } }, required: ['diff'] },
  },
  review: {
    type: 'object',
    properties: { summary: { type: 'string' } },
  },
  deviation: {
    type: 'object',
    properties: { description: { type: 'string' } },
    required: ['description'],
  },
} satisfies Record<string, RecordType>;

export const relations = [
  { name: 'approves', kind: 'supports', from: ['review'], to: ['plan'] },
  { name: 'settles', kind: 'answers', to: ['deviation'] },
] satisfies RelationName[];

export const gates = [
  {
    name: 'plan-ready',
    questions: [
      { kind: 'approved', of: { type: 'plan' }, by: { type: 'review' } },
      {
        kind: 'no_pending',
        pending: { type: 'deviation' },
        resolvedBy: { kind: 'answers' },
      },
    ],
  },
] satisfies Gate[];
