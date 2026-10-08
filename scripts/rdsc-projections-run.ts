// Núcleo do `rdsc-projections`: argumentos e montagem do snapshot JSONL de um processo. Fica num
// módulo irmão do entrypoint porque os scripts de leitura terminam com `process.exitCode = main(...)`
// sem guarda, e importar um deles sob o jest (CJS) executaria o `main`. Este módulo não tem efeito
// ao ser importado.
import { isEqual, isNil, isPlainObject, isUndefined } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { parseCliArgs } from './cli-error.ts';
import { escapeControls } from './escape-controls.ts';
import { Name, RecordId } from '../src/domain/ids.ts';
import type { Marker } from '../src/domain/ids.ts';
import { HexlogError } from '../src/errors.ts';
import type { composeReader } from '../src/compose.ts';
import type { QueryService } from '../src/queries/query-service.ts';

export const USAGE =
  'usage: node scripts/rdsc-projections.ts <project> <process> [--gate <name>]... [--gate-per-target <gate>:<regex>]... [--since <marker-json>]';

/** O lado de leitura que `run` usa: injetável nos specs. */
export type RdscReader = { query: Pick<QueryService, 'queryRecords' | 'evaluateGate'> } & Pick<
  ReturnType<typeof composeReader>,
  'loadProcess'
>;

export type RdscArgs = {
  project: Name;
  process: Name;
  gates: Name[];
  perTarget: { gate: Name; pattern: RegExp }[];
  since?: Marker;
};

type Line = Record<string, unknown>;

const MAX_READS = 3;
const SNAPSHOT_VERSION = 1;
const labelOrder = new Intl.Collator('en', { numeric: true });

/** `<gate>:<regex>` separado no primeiro `:` (nome de gate não contém `:`); regex sem flags. */
function parsePerTarget(raw: string): RdscArgs['perTarget'][number] | undefined {
  const colon = raw.indexOf(':');
  const gate = Name.safeParse(raw.slice(0, colon));
  const source = raw.slice(colon + 1);
  if (colon < 0 || !gate.success || isEmpty(source)) return undefined;
  try {
    return { gate: gate.data, pattern: new RegExp(source) };
  } catch {
    return undefined;
  }
}

/** Só `{ "<process>": <id>|null }` vale: outra chave, chave extra ou valor errado recusa o argv. */
function parseSince(raw: string, processName: Name): Marker | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // as chaves se checam sobre o resultado do `JSON.parse`: um `__proto__` do JSON vira chave própria
  if (!isPlainObject(value) || !isEqual(Object.keys(value), [processName])) return undefined;
  const id = RecordId.nullable().safeParse(value[processName]);
  return id.success ? { [processName]: id.data } : undefined;
}

/** `undefined` quando o argv não vale; o `main` responde com `USAGE`. */
export function parseRdscArgs(argv: string[]): RdscArgs | undefined {
  const parsed = parseCliArgs(argv, {
    gate: { type: 'string', multiple: true },
    'gate-per-target': { type: 'string', multiple: true },
    since: { type: 'string' },
  });
  const [projectArg, processArg, ...extra] = parsed?.positionals ?? [];
  const project = Name.safeParse(projectArg);
  const processName = Name.safeParse(processArg);
  if (isUndefined(parsed) || extra.length > 0 || !project.success || !processName.success) {
    return undefined;
  }
  const gates = (parsed.values.gate ?? []).map((gate) => Name.safeParse(gate));
  const perTarget = (parsed.values['gate-per-target'] ?? []).map(parsePerTarget);
  const rawSince = parsed.values.since;
  const since = isUndefined(rawSince) ? undefined : parseSince(rawSince, processName.data);
  if (
    gates.some(({ success }) => !success) ||
    perTarget.some(isUndefined) ||
    (!isUndefined(rawSince) && isUndefined(since))
  ) {
    return undefined;
  }
  return {
    project: project.data,
    process: processName.data,
    gates: gates.flatMap((gate) => (gate.success ? [gate.data] : [])),
    perTarget: perTarget.filter((item) => !isUndefined(item)),
    ...(isUndefined(since) ? {} : { since }),
  };
}

/** Primeiro segmento do target: é um `Name` válido, logo um `Target` válido. */
function labelOf(target: string): string {
  const dot = target.indexOf('.');
  return dot < 0 ? target : target.slice(0, dot);
}

/** `task-02` e `task-2` empatam no collator: o desempate por unidade de código mantém a saída estável. */
function naturalOrder(a: string, b: string): number {
  return labelOrder.compare(a, b) || Number(a > b) - Number(a < b);
}

/**
 * Duas leituras do mesmo processo (todos os registros e só os vigentes) conferidas pelo `marker`; se
 * um `register` cai entre elas, repete. Com `--since`, a segunda leva `changesSince` só quando o id
 * existe no log lido pela primeira (ou é `null`): `baseline` não depende do código do erro.
 */
function readConsistent({ query }: RdscReader, args: RdscArgs) {
  const { project, process: processName, since } = args;
  for (let attempt = 0; attempt < MAX_READS; attempt += 1) {
    // ponytail: a leitura carrega o processo inteiro numa chamada (teto de 64 MiB por processo, o mesmo
    // do export e do timeline); sem laço de cursor. Só vale para scripts de leitura, nunca para as tools MCP
    const all = query.queryRecords({
      project,
      process: processName,
      scope: 'process',
      includeNonCurrent: true,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const sinceId = since?.[processName];
    const baselined =
      !isUndefined(since) && (sinceId === null || all.records.some(({ id }) => id === sinceId));
    const current = query.queryRecords({
      project,
      process: processName,
      scope: 'process',
      limit: Number.MAX_SAFE_INTEGER,
      ...(baselined ? { changesSince: since } : {}),
    });
    if (isEqual(all.marker, current.marker)) return { all, current };
  }
  throw new HexlogError('INTERNAL', `marker changed on ${MAX_READS} consecutive reads`);
}

/** `GATE_NOT_FOUND` ou `PROJECT_SCOPE_UNSUPPORTED` quando o gate não avalia; `undefined` se avalia. */
function unavailableGate(gates: Record<string, { questions: { scope?: string }[] }>, gate: Name) {
  const definition = Object.hasOwn(gates, gate) ? gates[gate] : undefined;
  if (isUndefined(definition)) return 'GATE_NOT_FOUND';
  // o marcador nomeia só este processo: o que ele não nomeia seria lido como vazio, sem aviso
  return definition.questions.some(({ scope }) => scope === 'project')
    ? 'PROJECT_SCOPE_UNSUPPORTED'
    : undefined;
}

function gateLines(
  { query, loadProcess }: RdscReader,
  args: RdscArgs,
  marker: Marker,
  currentTargets: string[],
): Line[] {
  if (isEmpty(args.gates) && isEmpty(args.perTarget)) return [];
  const { project, process: processName } = args;
  // lido uma vez e só com gate pedido; uma cadeia adulterada já falhou na leitura dos registros
  const fixedGates = loadProcess({ project, process: processName }).manifest.fixed.gates;
  const labels = [...new Set(currentTargets.map(labelOf))].sort(naturalOrder);

  const linesFor = (gate: Name, targets: (string | null)[]): Line[] => {
    const error = unavailableGate(fixedGates, gate);
    if (!isUndefined(error)) return [{ kind: 'gate', gate, error }];
    return targets.map((target) => {
      // ponytail: `evaluateGate` reverifica o log a cada chamada, N rótulos custam N verificações;
      // subir para uma leitura única só se medir lento
      const { passed, questions } = query.evaluateGate({
        project,
        process: processName,
        gate,
        marker,
        ...(isNil(target) ? {} : { target }),
      });
      return {
        kind: 'gate',
        gate,
        target,
        passed,
        questions: questions.map(({ index, kind, passed: ok, evidence }) => ({
          index,
          kind,
          passed: ok,
          evidence,
        })),
      };
    });
  };

  return [
    ...args.gates.flatMap((gate) => linesFor(gate, [null])),
    ...args.perTarget.flatMap(({ gate, pattern }) =>
      linesFor(
        gate,
        labels.filter((label) => pattern.test(label)),
      ),
    ),
  ];
}

/** Monta o snapshot inteiro em memória e só então entrega as linhas a `out`; falha não deixa saída parcial. */
export function run(reader: RdscReader, args: RdscArgs, out: (text: string) => void): void {
  const { all, current } = readConsistent(reader, args);
  const { marker } = all;
  const currentIds = new Set(current.records.map(({ id }) => id));

  const records = all.records.map(
    ({
      id,
      type,
      at,
      target,
      author,
      data,
      in: incoming,
      out: outgoing,
      needsReview,
      attachmentStatus,
    }): Line => ({
      kind: 'record',
      id,
      type,
      at,
      target,
      author,
      // vem da segunda leitura (conferida pelo marker junto com a primeira)
      current: currentIds.has(id),
      data,
      in: incoming,
      out: outgoing,
      ...(isUndefined(needsReview) ? {} : { needsReview }),
      ...(isUndefined(attachmentStatus) ? {} : { attachmentStatus }),
    }),
  );
  const gates = gateLines(
    reader,
    args,
    marker,
    current.records.map(({ target }) => target),
  );
  const changes: Line[] = isUndefined(args.since)
    ? []
    : [
        {
          kind: 'changes',
          baseline: !isUndefined(current.changes),
          entered: current.changes?.entered ?? [],
          left: current.changes?.left ?? [],
        },
      ];

  const lines: Line[] = [
    {
      kind: 'meta',
      project: args.project,
      process: args.process,
      head: marker[args.process] ?? null,
      marker,
      version: SNAPSHOT_VERSION,
    },
    ...records,
    ...gates,
    ...changes,
    { kind: 'end', records: records.length, gates: gates.length },
  ];
  for (const line of lines) out(`${escapeControls(JSON.stringify(line))}\n`);
}
