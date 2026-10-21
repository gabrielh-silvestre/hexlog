// Confere os gates `pre-pr` e `gaps` de um trabalho: `node scripts/flow/gate.ts pre-pr <slug>`.
// Sai 0 com os dois verdes e 1 listando as perguntas reprovadas. Lê o log só pelo `composeReader`
// (`scripts/cli-error.ts#openReadOnly`), nunca o diretório de dados; por isso precisa de
// `node_modules`, ao contrário do hook `flow-hooks.ts`. O `mark.ts` chama `gateFailures`.
// Uso do CLI: conferir os gates à mão antes do `mark.ts`, sem gravar o marcador; nenhuma skill o
// chama (uso manual documentado em `docs/feedback-loops.md`, seção Rodar na mão). O único
// argumento aceito é `pre-pr` e ele avalia os dois gates, `pre-pr` e `gaps`.
import type { composeReader } from '../../src/compose.ts';
import { Name, Target } from '../../src/domain/ids.ts';
import { openReadOnly, reportCliError } from '../cli-error.ts';

const PROJECT = Name.parse('hexlog');
const GATES = ['pre-pr', 'gaps'] as const;
const USAGE = 'usage: node scripts/flow/gate.ts pre-pr <slug>';

export type GateFailure = { gate: string; kind: string; ids: string[] };

/**
 * Perguntas reprovadas de `pre-pr` e `gaps`, com os ids que as explicam. Avalia o gate fixado no
 * processo `slug`, com `target` igual a `slug`, como o passo do `evaluate_gate` da skill `flow-run`.
 */
export function gateFailures(
  reader: ReturnType<typeof composeReader>,
  slug: string,
): GateFailure[] {
  const process = Name.parse(slug);
  const target = Target.parse(slug);
  return GATES.flatMap((gate) => {
    const { questions } = reader.query.evaluateGate({
      project: PROJECT,
      process,
      gate: Name.parse(gate),
      target,
      evidence: 'failing',
    });
    return questions
      .filter(({ passed }) => !passed)
      .map((question) => ({
        gate,
        kind: question.kind,
        ids: Object.values(question.evidence ?? {}).flat(),
      }));
  });
}

/** Uma linha por pergunta reprovada: `<gate>: <pergunta>` e, se houver, `: <ids>`. */
export const describeFailures = (failures: readonly GateFailure[]): string =>
  failures
    .map(
      ({ gate, kind, ids }) => `${gate}: ${kind}${ids.length === 0 ? '' : `: ${ids.join(', ')}`}`,
    )
    .join('\n');

function main(argv: string[]): number {
  const [gate, slug, ...extra] = argv;
  const name = Name.safeParse(slug);
  if (gate !== 'pre-pr' || !name.success || extra.length > 0) {
    console.error(`flow gate failed: ${USAGE}`);
    return 1;
  }
  try {
    const failures = gateFailures(openReadOnly(), name.data);
    if (failures.length === 0) return 0;
    console.error(describeFailures(failures));
    return 1;
  } catch (error) {
    return reportCliError('flow gate', error);
  }
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- engine >=24.18.1 já suporta import.meta.main, plugin n ainda marca como experimental
if (import.meta.main) process.exitCode = main(process.argv.slice(2));
