import * as fs from 'node:fs';
import { randomUUIDv7 } from 'node:crypto';
import { isNil } from 'es-toolkit';
import * as fc from 'fast-check';
import MiniSearch from 'minisearch';
import { expectedPrevHash, nextSeq } from '../../src/chain.ts';
import type { ProcessManifest, Vocabulary } from '../../src/definitions.ts';
import { stripDiacritics, indexableText } from '../../src/search.ts';
import type { EventLine } from '../../src/events.ts';

// Marcadas como "obrigatórias" pelo passo 7c (âncoras que os ACs M11/M12 exigem, sem depender
// da distribuição aleatória do gerador para aparecerem).
const PHRASE_CACHE_INVALIDATION_TRUE = 'cache invalidation applied correctly in this round';
const PHRASE_CACHE_INVALIDATED_DECOY = 'cache invalidated in the previous process';
const PHRASE_CACHE_VALIDATION_DECOY = 'cache validation with no problems recorded';
const PHRASE_LOGIN = 'login performed by the user successfully';
const PHRASE_CAFE = 'café orders logged during the review meeting';

// Banco geral: nunca contém a palavra "problem" junto de "webhook" (M11i depende disso).
const PHRASES_GENERAL = [
  'general process review completed with no pending items',
  'note recorded by the agent responsible for the step',
  'routine check with no pending items found',
  'configuration adjustment applied successfully',
  'internal documentation updated at this step',
  'there was an isolated problem in general processing',
];
const PHRASES_AUTHENTICATION = [
  'authentication process completed successfully',
  'user authentication failure reported',
  'two-factor authentication enabled',
];
const PHRASES_PAYMENT = [
  'payment processed with no apparent errors',
  'payment refund requested by the client',
];
const PHRASES_WEBHOOK = [
  'webhook received from the external partner',
  "webhook triggered for the client's system",
  'automatic webhook resend configured',
];
const PHRASE_BANK = [
  ...PHRASES_GENERAL,
  ...PHRASES_AUTHENTICATION,
  ...PHRASES_PAYMENT,
  ...PHRASES_WEBHOOK,
];

const TARGETS_BASE = [
  'hex:target:account-1',
  'hex:target:account-2',
  'hex:target:order-1',
  'hex:target:payment-1',
  'hex:target:session-1',
];
const TARGETS_LOGIN = [
  'hex:target:login',
  'hex:target:login-1',
  'hex:target:login-2',
  'hex:target:login-3',
  'hex:target:login-4',
  'hex:target:login-5',
  'hex:target:login-6',
];
const CORPUS_TARGETS = [...TARGETS_BASE, ...TARGETS_LOGIN];

type MilestoneIntent = {
  category: 'milestone';
  milestoneType: string;
  target: string;
  text?: string;
  withCount: boolean;
};
type VerdictIntent = { category: 'verdict'; target: string; result: string; text: string };
type CustomIntent = { category: 'custom'; text: string; tag: string; hiddenTarget?: string };
type Intent = MilestoneIntent | VerdictIntent | CustomIntent;

function pick<T>(list: T[], fallback: T, index: number): T {
  return list.length > 0 ? list[index % list.length] : fallback;
}

/** Eventos garantidos pelos ACs (M11c, M11i, M12a, M12b): não dependem da amostragem aleatória. */
function anchors(vocabulary: Vocabulary): Intent[] {
  const milestoneType = pick(vocabulary.core.milestoneType, 'approved', 0);
  const result = pick(vocabulary.core.result, 'ok', 0);
  const withDecision = (target: string, text: string): MilestoneIntent => ({
    category: 'milestone',
    milestoneType,
    target,
    text,
    withCount: false,
  });

  return [
    withDecision('hex:target:cache-1', PHRASE_CACHE_INVALIDATION_TRUE),
    withDecision('hex:target:cache-2', PHRASE_CACHE_INVALIDATED_DECOY),
    withDecision('hex:target:cache-3', PHRASE_CACHE_VALIDATION_DECOY),
    { category: 'verdict', target: 'hex:target:login', result, text: PHRASE_LOGIN },
    { category: 'verdict', target: 'hex:target:login-1', result, text: PHRASE_LOGIN },
    {
      category: 'verdict',
      target: 'hex:target:account-1',
      result: 'result-outside-vocabulary',
      text: PHRASES_GENERAL[0],
    },
    { category: 'verdict', target: 'hex:target:account-2', result, text: PHRASES_WEBHOOK[0] },
    { category: 'verdict', target: 'hex:target:account-3', result, text: PHRASES_WEBHOOK[1] },
    withDecision('hex:target:account-4', PHRASES_WEBHOOK[2]),
    withDecision('hex:target:note-1', PHRASE_CAFE),
  ];
}

type Draft = {
  category: 'milestone' | 'verdict' | 'custom';
  bank: number;
  targetIndex: number;
  resultOutsideVocab: boolean;
  withDecisions: boolean;
};

const DRAFT_ARB: fc.Arbitrary<Draft> = fc.record({
  category: fc.oneof(
    { weight: 4, arbitrary: fc.constant<'milestone'>('milestone') },
    { weight: 4, arbitrary: fc.constant<'verdict'>('verdict') },
    { weight: 2, arbitrary: fc.constant<'custom'>('custom') },
  ),
  bank: fc.nat({ max: 9999 }),
  targetIndex: fc.nat({ max: 9999 }),
  resultOutsideVocab: fc.boolean(),
  withDecisions: fc.boolean(),
});

function toIntent(d: Draft, vocabulary: Vocabulary, index: number): Intent {
  const target = CORPUS_TARGETS[d.targetIndex % CORPUS_TARGETS.length];
  const text = PHRASE_BANK[d.bank % PHRASE_BANK.length];

  if (d.category === 'milestone') {
    const milestoneType = pick(vocabulary.core.milestoneType, 'approved', d.bank);
    return {
      category: 'milestone',
      milestoneType,
      target,
      text: d.withDecisions ? text : undefined,
      withCount: d.bank % 5 === 0,
    };
  }
  if (d.category === 'verdict') {
    const resultBase = pick(vocabulary.core.result, 'ok', d.bank);
    const result = d.resultOutsideVocab ? `external-result-${index}` : resultBase;
    return { category: 'verdict', target, result, text };
  }
  return {
    category: 'custom',
    text,
    tag: `tag-${d.bank % 7}`,
    hiddenTarget: d.bank % 11 === 0 ? target : undefined,
  };
}

function dataFromIntent(intent: Intent): Record<string, unknown> {
  if (intent.category === 'milestone') {
    const data: Record<string, unknown> = {
      milestoneType: intent.milestoneType,
      target: intent.target,
    };
    if (intent.withCount) data.count = { field: 'items processed', value: 1 };
    if (!isNil(intent.text))
      data.decisions = [{ item: 'item-1', action: 'follow', text: intent.text }];
    return data;
  }
  if (intent.category === 'verdict') {
    return {
      claim: intent.text,
      source: 'corpus-fixture',
      result: intent.result,
      evidence: 'evidence generated by the corpus',
      target: intent.target,
      origin: 'generateCorpus',
      trace: 'synthetic-trace',
    };
  }
  const data: Record<string, unknown> = {
    text: intent.text,
    detail: { note: `note about ${intent.tag}` },
    tags: [intent.tag, 'synthetic'],
  };
  if (!isNil(intent.hiddenTarget)) data.relatedTarget = intent.hiddenTarget;
  return data;
}

function typeFromIntent(intent: Intent, customTypeName: string): string {
  if (intent.category === 'milestone') return 'milestone';
  if (intent.category === 'verdict') return 'verdict';
  return customTypeName;
}

function buildLines(manifest: ProcessManifest, intents: Intent[]): EventLine[] {
  const customTypeName = Object.keys(manifest.fixed.types)[0] ?? 'note';
  const lines: EventLine[] = [];
  let lastLink: EventLine | null = null;

  intents.forEach((intent, index) => {
    const type = typeFromIntent(intent, customTypeName);
    const line: EventLine = {
      seq: nextSeq(lastLink, 0),
      id: `${manifest.project}:${manifest.process}:${type}:${randomUUIDv7()}`,
      type,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      agent: 'corpus-agent',
      prevHash: expectedPrevHash(lastLink, manifest),
      data: dataFromIntent(intent),
    };
    lines.push(line);
    lastLink = line;
  });

  return lines;
}

const TOKENIZE = MiniSearch.getDefault('tokenize') as (text: string) => string[];

/** Força bruta: índices cujo `indexableText` normalizado contém `term` como prefixo de algum token. */
function goldenForTerm(lines: EventLine[], term: string): number[] {
  const needle = stripDiacritics(term);
  return lines
    .map((line, index) => ({
      index,
      tokens: TOKENIZE(indexableText(line)).map(stripDiacritics),
    }))
    .filter(({ tokens }) => tokens.some((token: string) => token.startsWith(needle)))
    .map(({ index }) => index);
}

/**
 * Gera um corpus determinístico (`fc.sample`, seed fixa) com cadeia de hash válida (`chain.ts`),
 * ~40% Milestone, ~40% Verdict, ~20% custom, mais as âncoras exigidas pelos ACs M11/M12 (§4.17, passo 7c).
 */
export function generateCorpus(options: {
  size: number;
  seed?: number;
  manifest: ProcessManifest;
  vocabulary: Vocabulary;
}): { lines: EventLine[]; text: string; expected: (term: string) => number[] } {
  const { size, seed = 42, manifest, vocabulary } = options;

  const fixed = anchors(vocabulary);
  const drafts = fc.sample(DRAFT_ARB, { seed, numRuns: Math.max(0, size - fixed.length) });
  const intents = [...fixed, ...drafts.map((d, i) => toIntent(d, vocabulary, i))];

  const lines = buildLines(manifest, intents);
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

  return { lines, text, expected: (term: string) => goldenForTerm(lines, term) };
}

export function writeCorpus(file: string, text: string): void {
  fs.writeFileSync(file, text);
}
