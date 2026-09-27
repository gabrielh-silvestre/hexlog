// Hook PostToolUse para a tool Skill: nunca bloqueia, só lembra (injeta
// contexto) de cruzar via `hexlog-flow` quando o `.hexlog/flow.md` do repo
// alvo mapeia a skill invocada numa fase do processo. Segundo modo
// (`--validate <path>`) reaproveita o mesmo parser para a `hexlog-setup`
// autoconferir o flow map que acabou de escrever.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNil, isString } from 'es-toolkit';
import { parseFlowMap, type FlowMap } from '../src/flow-map.ts';

interface RawInput {
  tool_name?: unknown;
  tool_input?: { skill?: unknown };
  cwd?: unknown;
}

function asRawInput(input: unknown): RawInput | undefined {
  return !isNil(input) && typeof input === 'object' ? input : undefined;
}

function extractSkillName(input: unknown): string | undefined {
  const rawInput = asRawInput(input);
  if (isNil(rawInput) || rawInput.tool_name !== 'Skill') return undefined;
  const skill = rawInput.tool_input?.skill;
  return isString(skill) ? skill : undefined;
}

function extractCwd(input: unknown): string | undefined {
  const cwd = asRawInput(input)?.cwd;
  return isString(cwd) ? cwd : undefined;
}

/** Fase (se houver) cuja lista de skills mapeadas contém `skillName`. */
function phaseForSkill(flowMap: FlowMap, skillName: string): string | undefined {
  return flowMap.phases.find((phase) => (flowMap.skills[phase] ?? []).includes(skillName));
}

function reminderMessage(flowMap: FlowMap, phase: string): string {
  return `hexlog: fase "${phase}" (process "${flowMap.process[phase]}") — registre/cruze via hexlog-flow.`;
}

/** Decisão pura do hook a partir do payload e do texto já lido de `.hexlog/flow.md` (`undefined` se ausente). */
function decide(input: unknown, flowMapText: string | undefined): string | undefined {
  const skillName = extractSkillName(input);
  if (isNil(skillName) || isNil(flowMapText)) return undefined;

  const parsed = parseFlowMap(flowMapText);
  if (!parsed.success || !parsed.data.hook) return undefined;

  const phase = phaseForSkill(parsed.data, skillName);
  return isNil(phase) ? undefined : reminderMessage(parsed.data, phase);
}

function readFlowMapText(cwd: string): string | undefined {
  const file = path.join(cwd, '.hexlog', 'flow.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

function runHook(): void {
  const stdinInput = fs.readFileSync(0, 'utf8');
  const input: unknown = JSON.parse(stdinInput);
  const cwd = extractCwd(input) ?? process.cwd();
  const message = decide(input, readFlowMapText(cwd));
  if (isNil(message)) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    }),
  );
}

/** Modo reaproveitado pela `hexlog-setup` para autoconferir o `.hexlog/flow.md` recém-escrito. */
function runValidate(file: string): void {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseFlowMap(text);
  if (parsed.success) return;
  for (const issue of parsed.issues) console.log(issue);
  process.exitCode = 1;
}

/** `import.meta.main` não sobrevive ao bundle do esbuild: compara o caminho do entrypoint. */
function isExecutedDirectly(): boolean {
  try {
    return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  if (process.argv[2] === '--validate') {
    const file = process.argv[3];
    if (isNil(file)) {
      process.stderr.write('usage: flow-reminder.ts --validate <path>\n');
      process.exitCode = 1;
    } else {
      runValidate(file);
    }
  } else {
    try {
      runHook();
    } catch {
      // R-1 (mesma garantia de hook/bash-guard.ts): falha aberto, nunca bloqueia nem quebra o agente.
      process.exitCode = 0;
    }
  }
}
