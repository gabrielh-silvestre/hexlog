// Relatório read-only da autoria das decisões: por processo, conta as decisões vigentes pelo
// `decidedBy` efetivo (`agent` declarado, `agent` sem o campo, `human`, `third-party`) e lista as
// `human` e `third-party` sem base. Identifica as arestas pela espécie (`supports`), não pelo nome,
// como o `seat-report`: base é a aresta vigente que chega de um registro vigente de tipo de evidência
// (`own-judgment`, `external-team`, `doc-author`, `convergence`); a aprovação (aresta vinda de
// `approval`) não é base e só aparece como marca na linha. A decisão
// `agent` nunca é acusada. Vigência, arestas e herança pela linhagem vêm de `queryRecords` com
// `relations: "full"` (`in` com `current` e `inheritedIn`), como o `seat-report`; o `decidedBy` não sai
// da `query`, então vem dos elos crus por id (`loadProcess`), que também dão os tipos fixados. Processo
// sem nenhum tipo de evidência fixado sai como "not applicable", sem acusar. Processo sem herança pela
// linhagem só tem a aresta direta, e a saída diz isso. Limite real: a leitura é por processo, então
// evidência gravada em outro processo não é vista, e a saída diz isso. Tipo ausente no projeto (o da
// decisão sempre; os demais só quando citados em `--types`) recusa (exit 1). Um processo que não se lê
// é listado como "unreadable" e os demais seguem. A saída escapa os controles de terminal
// (`escapeControls`) e todo valor controlado pelo agente sai entre aspas por `JSON.stringify`. Cada lista
// tem teto de 100 e traz o total.
// Uso: node scripts/authorship-report.ts <project> [--process <name>] [--types decision=<t>,own-judgment=<t>,...]
// Saída: 0 íntegro (com os achados listados); 2 dado 0.x ou log quebrado; 1 uso incorreto ou erro.
import { isNil, isUndefined } from 'es-toolkit';
import { formatCliError, openReadOnly, parseCliArgs, reportCliError } from './cli-error.ts';
import { escapeControls } from './escape-controls.ts';
import { Name } from '../src/domain/ids.ts';
import type { DecidedBy } from '../src/domain/record.ts';
import { invalidInput } from '../src/errors.ts';
import type { QueryRecord, QueryService } from '../src/queries/query-service.ts';

const USAGE =
  'usage: node scripts/authorship-report.ts <project> [--process <name>] [--types decision=<t>,own-judgment=<t>,external-team=<t>,doc-author=<t>,convergence=<t>,approval=<t>]';

const EVIDENCE_ROLES = ['own-judgment', 'external-team', 'doc-author', 'convergence'] as const;
const ROLES = ['decision', ...EVIDENCE_ROLES, 'approval'] as const;
type Role = (typeof ROLES)[number];
type Types = Record<Role, Name>;

const EDGE_KIND = 'supports';
const LIST_CAP = 100;
const UNBACKED_ROLES = ['human', 'third-party'] as const;
const COUNT_LABELS = ['agent (declared)', 'agent (no field)', ...UNBACKED_ROLES] as const;
type CountLabel = (typeof COUNT_LABELS)[number];

type ParsedTypes = { types: Types; given: Role[] };

/** `decision=a,own-judgment=b`: cada papel não citado fica com o próprio nome; `undefined` quando não vale. */
function parseTypes(raw: string | undefined): ParsedTypes | undefined {
  const types = Object.fromEntries(ROLES.map((role) => [role, role])) as Types;
  const given: Role[] = [];
  for (const item of isUndefined(raw) ? [] : raw.split(',')) {
    const [role, value, ...rest] = item.split('=');
    const name = Name.safeParse(value);
    if (!ROLES.includes(role as Role) || rest.length > 0 || !name.success) return undefined;
    types[role as Role] = name.data;
    given.push(role as Role);
  }
  return { types, given };
}

function recordsOf(
  query: QueryService,
  project: Name,
  processName: Name,
  type: Name,
): QueryRecord[] {
  // chamada única, como o `seat-report`: o teto de 64 MiB por processo limita a memória
  return query.queryRecords({
    project,
    process: processName,
    type,
    relations: 'full',
    limit: Number.MAX_SAFE_INTEGER,
  }).records;
}

/** Os tipos que o relatório lê (o da decisão e os citados em `--types`) têm de existir no projeto. */
function assertTypesDefined(
  query: QueryService,
  project: Name,
  { types, given }: ParsedTypes,
): void {
  const defined = new Set(query.list({ project }).project?.types.map(({ name }) => name));
  const names = [...new Set<Role>(['decision', ...given])]
    .filter((role) => !defined.has(types[role]))
    .map((role) => `${role}=${types[role]}`);
  if (names.length === 0) return;
  throw invalidInput(
    '/types',
    'unknown-type',
    `type not defined in the project: ${names.join(', ')}`,
  );
}

function quoted(value: string | undefined): string {
  return isUndefined(value) ? '-' : JSON.stringify(value);
}

function labelOf(role: DecidedBy | undefined): CountLabel {
  if (isUndefined(role)) return 'agent (no field)';
  return role === 'agent' ? 'agent (declared)' : role;
}

function hasBasis(decision: QueryRecord, evidenceIds: Set<string>): boolean {
  const isBasis = ({ kind, from }: { kind: string; from: string }) =>
    kind === EDGE_KIND && evidenceIds.has(from);
  return (
    (decision.in ?? []).some((edge) => edge.current && isBasis(edge)) ||
    (decision.inheritedIn ?? []).some(isBasis)
  );
}

function decisionLine(decision: QueryRecord, approvalIds: Set<string>): string {
  const { agent, model, client } = decision.author;
  const approved = (decision.in ?? []).some(
    ({ kind, from, current }) => kind === EDGE_KIND && current && approvalIds.has(from),
  );
  return [
    `${decision.id}  ${decision.target}`,
    `agent=${quoted(agent)}  model=${quoted(model)}  client=${quoted(client)}`,
    ...(approved ? ['(approved, but approval is not a basis)'] : []),
  ].join('  ');
}

function idsOf(
  query: QueryService,
  project: Name,
  processName: Name,
  pinned: Set<string>,
  names: Name[],
): Set<string> {
  return new Set(
    names
      .filter((name) => pinned.has(name))
      .flatMap((name) => recordsOf(query, project, processName, name).map(({ id }) => id)),
  );
}

function cappedList(title: string, lines: string[]): string[] {
  const omitted = lines.length - LIST_CAP;
  return [
    `  ${title} (${lines.length})`,
    ...lines.slice(0, LIST_CAP).map((line) => `    ${line}`),
    ...(omitted > 0 ? [`    ... ${omitted} more not shown`] : []),
  ];
}

function processReport(
  reader: ReturnType<typeof openReadOnly>,
  project: Name,
  processName: Name,
  types: Types,
): string[] {
  const { query } = reader;
  const { manifest, records } = reader.loadProcess({ project, process: processName });
  const roleById = new Map(records.map(({ id, decidedBy }) => [id, decidedBy]));
  const pinned = new Set(Object.keys(manifest.fixed.types));
  const evidenceNames = EVIDENCE_ROLES.map((role) => types[role]);
  const applicable = evidenceNames.some((name) => pinned.has(name));
  const evidenceIds = idsOf(query, project, processName, pinned, evidenceNames);
  const approvalIds = idsOf(query, project, processName, pinned, [types.approval]);

  const counts = Object.fromEntries(COUNT_LABELS.map((label) => [label, 0])) as Record<
    CountLabel,
    number
  >;
  const unbacked: Record<(typeof UNBACKED_ROLES)[number], string[]> = {
    human: [],
    'third-party': [],
  };
  const decisions = recordsOf(query, project, processName, types.decision);
  for (const decision of decisions) {
    const role = roleById.get(decision.id);
    counts[labelOf(role)] += 1;
    if (
      (role === 'human' || role === 'third-party') &&
      applicable &&
      !hasBasis(decision, evidenceIds)
    ) {
      unbacked[role].push(decisionLine(decision, approvalIds));
    }
  }

  return [
    `process ${processName} (${decisions.length} current decisions)`,
    ...COUNT_LABELS.map((label) => `  ${label}: ${counts[label]}`),
    ...(applicable
      ? [
          ...(manifest.lineageInheritance === true
            ? []
            : ['  lineage inheritance is off: only direct supports edges are read']),
          ...UNBACKED_ROLES.flatMap((role) => cappedList(`${role} without basis`, unbacked[role])),
        ]
      : ['  not applicable: no evidence type pinned']),
  ];
}

function main(argv: string[]): number {
  const args = parseCliArgs(argv, { process: { type: 'string' }, types: { type: 'string' } });
  const [projectArg, ...extra] = args?.positionals ?? [];
  if (isNil(args) || isNil(projectArg) || extra.length > 0) {
    console.error(`authorship-report failed: ${USAGE}`);
    return 1;
  }
  const project = Name.safeParse(projectArg);
  const processArg = args.values.process;
  const scope = isUndefined(processArg) ? undefined : Name.safeParse(processArg);
  const parsed = parseTypes(args.values.types);
  if (!project.success || (scope && !scope.success) || isUndefined(parsed)) {
    console.error(
      'authorship-report failed: INVALID_INPUT: project, process and --types names must be valid',
    );
    return 1;
  }

  try {
    const reader = openReadOnly();
    assertTypesDefined(reader.query, project.data, parsed);
    const names = isUndefined(scope) ? reader.list(project.data) : [scope.data];
    let exitCode = 0;
    const blocks = names.map((name) => {
      try {
        return processReport(reader, project.data, name, parsed.types);
      } catch (error) {
        const failure = formatCliError('authorship-report', error);
        exitCode = Math.max(exitCode, failure.exitCode);
        return [`process ${name}`, `  unreadable: ${failure.text}`];
      }
    });
    const text = [
      ...blocks.map((lines) => lines.join('\n')),
      'note: edges from another process are not read',
    ].join('\n\n');
    process.stdout.write(escapeControls(`${text}\n`));
    return exitCode;
  } catch (error) {
    return reportCliError('authorship-report', error);
  }
}

process.exitCode = main(process.argv.slice(2));
