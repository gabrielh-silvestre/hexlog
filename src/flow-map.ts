import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { FixedVersions } from './definitions.ts';
import { Name } from './events.ts';

// Mesmo regex embutido em `Target` (events.ts:30) — default do `<id>` de target quando o
// frontmatter não configura um padrão próprio.
const DEFAULT_TARGET_ID_PATTERN = '[^\\s:]+';

function isValidRegexSource(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** Issue de referência cruzada: chave de `field` aponta pra uma fase fora de `phases`. */
function unknownPhaseIssue(ctx: z.core.$RefinementCtx, field: string, phase: string): void {
  ctx.addIssue({
    code: 'custom',
    path: [field, phase],
    message: `phase "${phase}" is not declared in phases`,
  });
}

export const FlowMap = z
  .object({
    phases: z.array(Name).min(1),
    // 1:1 — cada fase declarada em `phases` tem exatamente um processo mapeado.
    process: z.record(Name, Name),
    // Opcional por fase: nem toda fase precisa de skills mapeadas. Nome de skill não é `Name`
    // (namespace com `:`, ex. `oh-my-claudecode:ralph`, é uma skill real e válida).
    skills: z.record(Name, z.array(z.string().min(1))).default({}),
    // Opcional por fase: nome do gate custom (deve existir em `register_gate`, checado fora deste schema).
    gate: z.record(Name, Name).default({}),
    targetIdPattern: z
      .string()
      .default(DEFAULT_TARGET_ID_PATTERN)
      .refine(isValidRegexSource, { message: 'targetIdPattern must be a valid regex source' }),
    versions: FixedVersions.optional(),
    hook: z.boolean().default(false),
    // Skills apontadas na descoberta que a `hexlog-setup` efetivamente editou pra chamar a `hexlog-flow`.
    editedSkills: z.array(z.string()).default([]),
  })
  .superRefine((flowMap, ctx) => {
    const phaseSet = new Set(flowMap.phases);

    for (const phase of flowMap.phases) {
      if (!(phase in flowMap.process)) {
        ctx.addIssue({
          code: 'custom',
          path: ['process', phase],
          message: `phase "${phase}" has no process mapped`,
        });
      }
    }
    for (const phase of Object.keys(flowMap.process)) {
      if (!phaseSet.has(phase)) unknownPhaseIssue(ctx, 'process', phase);
    }
    for (const phase of Object.keys(flowMap.skills)) {
      if (!phaseSet.has(phase)) unknownPhaseIssue(ctx, 'skills', phase);
    }
    for (const phase of Object.keys(flowMap.gate)) {
      if (!phaseSet.has(phase)) unknownPhaseIssue(ctx, 'gate', phase);
    }
  });
export type FlowMap = z.infer<typeof FlowMap>;

// Frontmatter YAML delimitado por `---` no início do arquivo, corpo markdown depois.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/**
 * Extrai e valida o frontmatter de `.hexlog/flow.md`. Puro (sem tocar disco): recebe o texto já
 * lido. Não é resposta de tool MCP — não usa `HexlogError`/`ErrorCode`, devolve `issues` como
 * strings legíveis diretamente.
 */
export function parseFlowMap(
  text: string,
): { success: true; data: FlowMap } | { success: false; issues: string[] } {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    return { success: false, issues: ['missing frontmatter block (--- ... ---)'] };
  }

  let raw: unknown;
  try {
    raw = parseYaml(match[1]);
  } catch (error) {
    return { success: false, issues: [`invalid YAML: ${(error as Error).message}`] };
  }

  const result = FlowMap.safeParse(raw);
  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.map((issue) => `${issue.path.join('/')}: ${issue.message}`),
    };
  }
  return { success: true, data: result.data };
}
