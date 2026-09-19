import { isString } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat'; // isEmpty só existe em es-toolkit/compat (1.52.0)
import { z } from 'zod';
import { BUILTIN_GATE_NAMES } from './definitions.ts';
import { GateMilestoneData as GateMilestoneDataSchema } from './events.ts';
import type { State } from './state.ts';

// §4.16: tetos de prova de gate. Custom (CUSTOM_EVIDENCE_MAX/EVIDENCE_ITEM_MAX_CHARS) e
// CRITERIA_MAX_CHARS são validados no inputSchema da tool, não aqui.
export const BUILTIN_EVIDENCE_MAX = 50;
export const CUSTOM_EVIDENCE_MAX = 20;
export const EVIDENCE_ITEM_MAX_CHARS = 2000;
export const CRITERIA_MAX_CHARS = 2000;

export type BuiltinGateName = (typeof BUILTIN_GATE_NAMES)[number];

/** Forma canônica de `data.gate` gravado pelo Milestone de gate (§4.5/§4.11): nunca boolean solto. */
export type GateMilestoneData = z.infer<typeof GateMilestoneDataSchema>;

export type EvaluationResult = {
  passed: boolean;
  evidence: unknown[];
  totalEvidenceItems: number;
  evaluatedThrough: { id: string; seq: number; timestamp: string } | null;
};

type BuiltinGateDefinition = { criteria: string; items: (state: State) => unknown[] };

// §4.11: textos de `criteria` exatamente como a tabela do plano.
export const BUILTIN_GATES: Record<BuiltinGateName, BuiltinGateDefinition> = {
  'no-orphans': {
    criteria:
      'state.orphans empty: no Milestone with dueAt < now and no later event on the same target',
    items: (state) => state.orphans,
  },
  'no-conflicts': {
    criteria: 'state.conflicts empty: no (target, claim) with more than one active Verdict',
    items: (state) => state.conflicts,
  },
  'chain-intact': {
    criteria: 'chain.ok = true',
    items: (state) => state.chain.breaks,
  },
  'no-invalid-references': {
    criteria: 'state.invalidReferences empty: every supersedes points to an existing Verdict',
    items: (state) => state.invalidReferences,
  },
  'no-forks': {
    criteria: 'state.forks empty: no Verdict with more than one active successor',
    items: (state) => state.forks,
  },
};

export function isBuiltinGate(name: string): name is BuiltinGateName {
  return (BUILTIN_GATE_NAMES as readonly string[]).includes(name);
}

/**
 * Mudança 1 (D1): critério de um gate de regra — piso de targets, sob `targetPattern` (prefixo
 * literal, mesmo estilo de match do hook de guard do repo, não regex livre), cujo `claim` vigente em
 * `state.active` está em `acceptedResults`. `requireVigente: true` só conta status `'active'` (vigente
 * sem disputa); com `requireVigente: false`, `'conflict'` (candidatos ainda em disputa) também conta.
 */
export const RuleGateSpec = z.strictObject({
  targetPattern: z.string().min(1).max(200),
  requireVigente: z.boolean(),
  acceptedResults: z.array(z.string().min(1).max(200)).min(1).max(100),
  minCount: z.number().int().min(0),
});
export type RuleGateSpec = z.infer<typeof RuleGateSpec>;

/** Avalia um gate de regra (§4.11, mudança 1): conta os targets de `state.active` que batem `spec`,
 *  corta a prova em 50 como os builtins já fazem. */
export function evaluateRule(spec: RuleGateSpec, state: State): EvaluationResult {
  const matches = state.active
    .filter((entry) => entry.target.startsWith(spec.targetPattern))
    .filter((entry) => !spec.requireVigente || entry.status === 'active')
    .filter((entry) => spec.acceptedResults.includes(entry.claim))
    .map((entry) => entry.target);

  return {
    passed: matches.length >= spec.minCount,
    evidence: matches.slice(0, BUILTIN_EVIDENCE_MAX),
    totalEvidenceItems: matches.length,
    evaluatedThrough: state.logThrough,
  };
}

/** Avalia um gate embutido contra `state` (§4.11): sem items → passa; senão, corta a prova em 50. */
export function evaluateBuiltin(name: BuiltinGateName, state: State): EvaluationResult {
  const items = BUILTIN_GATES[name].items(state);
  return {
    passed: isEmpty(items),
    evidence: items.slice(0, BUILTIN_EVIDENCE_MAX),
    totalEvidenceItems: items.length,
    evaluatedThrough: state.logThrough,
  };
}

/** `evidence` de gate custom, vinda do agente: string vira lista de um item. */
export function normalizeCustomEvidence(evidence: string | string[]): string[] {
  return isString(evidence) ? [evidence] : evidence;
}

/** Monta e valida `GateMilestoneData` (§4.5) para o Milestone de gate, embutido ou custom. */
export function buildGateMilestoneData(args: {
  name: string;
  origin: 'builtin' | 'custom' | 'rule';
  criteria: string;
  target: string;
  result: EvaluationResult;
}): GateMilestoneData {
  return GateMilestoneDataSchema.parse({
    milestoneType: 'gate',
    target: args.target,
    gate: { name: args.name, origin: args.origin, criteria: args.criteria, ...args.result },
  });
}

/** Para `listBuiltinGates`: nome e critério dos 5 gates embutidos. */
export function listBuiltinGates(): { name: string; criteria: string }[] {
  return BUILTIN_GATE_NAMES.map((name) => ({ name, criteria: BUILTIN_GATES[name].criteria }));
}
