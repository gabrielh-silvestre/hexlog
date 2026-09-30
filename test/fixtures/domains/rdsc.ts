import type { Gate, RecordType, RelationName } from '../../../src/domain/definitions.ts';

/** Fluxo rdsc: um veredito se apoia em evidência, e uma versão nova do veredito substitui a antiga. */
export const types = {
  evidence: {
    type: 'object',
    properties: { source: { type: 'string' } },
  },
  verdict: {
    type: 'object',
    properties: { conclusion: { type: 'string' } },
    required: ['conclusion'],
  },
} satisfies Record<string, RecordType>;

export const relations = [
  { name: 'based-on', kind: 'supports', from: ['verdict'], to: ['evidence'] },
  { name: 'replaces', kind: 'supersedes' },
] satisfies RelationName[];

export const gates = [
  {
    name: 'settled',
    questions: [
      { kind: 'occurred', select: { type: 'verdict' } },
      { kind: 'no_open_contradiction' },
    ],
  },
] satisfies Gate[];
