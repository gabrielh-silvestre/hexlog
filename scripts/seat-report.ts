// Relatório read-only da auditoria da cadeira do dono: lê, pelo `composeReader`, os registros vigentes
// dos tipos `gap`, `premise` e `audit` e separa as respostas por quanto já foi auditado. Não lê anexo:
// a marca "sem critério" sai só do registro, e o hash do `criteria` aparece abreviado. Identifica as
// arestas pela espécie (`answers`, `supports`) e por `current`, então sobrevive ao mapeamento de nomes
// de `--types`. Aval é a aresta `supports` vigente que chega de um registro do tipo `audit`; o `audit`
// de retirada (carregador do `revokes`, sem essa aresta) não conta. Seções exclusivas, na ordem de
// precedência: cada registro aparece numa só. A saída escapa os controles de terminal (`escapeControls`),
// e todo valor controlado pelo agente (agent, model, rule, criteria, action, question) sai entre aspas
// por `JSON.stringify`, para não introduzir quebra de linha, TAB nem marca falsa de seção ou de aval.
// A resposta a uma lacuna superada ou revogada (aresta `answers` sem destino vigente) sai na última
// seção, para não sumir. `answeredBy` fora de `human` e `simulated` (ex.: `simulated-approved`) tem
// seção própria, com o valor entre aspas na linha, e nunca conta como humano; `basis` fora de `rule`
// e `judgment` é motivo de "sem critério" distinto de `basis` ausente. Papel sem nenhum registro
// cujo tipo não existe no projeto recusa o relatório
// (exit 1): pacote ausente ou tipo errado em `--types` não passa por "nada a auditar". O autor é
// autodeclarado: a linha traz `client` e marca a resposta `human` cujo `agent` é de ocupante e o aval
// do mesmo autor da resposta, mas a conferência continua manual. Limite real: com `--process` só se
// enxergam as arestas do próprio processo, então a lacuna respondida a partir de outro processo
// aparece como aberta (o escopo projeto não tem o problema).
// Uso: node scripts/seat-report.ts <project> [--process <name>] [--types gap=<t>,premise=<t>,audit=<t>]
// Saída: 0 íntegro (com os achados listados); 2 dado 0.x ou log quebrado; 1 uso incorreto ou erro.
import { isNil, isUndefined } from 'es-toolkit';
import { openReadOnly, parseCliArgs, reportCliError } from './cli-error.ts';
import { escapeControls } from './escape-controls.ts';
import { Name } from '../src/domain/ids.ts';
import { invalidInput } from '../src/errors.ts';
import type { QueryRecord, QueryService } from '../src/queries/query-service.ts';

const USAGE =
  'usage: node scripts/seat-report.ts <project> [--process <name>] [--types gap=<t>,premise=<t>,audit=<t>]';

const ROLES = ['gap', 'premise', 'audit'] as const;
type Role = (typeof ROLES)[number];
type Types = Record<Role, Name>;

const GROUPS = {
  withoutCriteria: 'simulated answers without criteria',
  openGaps: 'open gaps',
  notAudited: 'simulated answers not audited',
  audited: 'audited answers',
  human: 'human answers',
  unattributed: 'answers without answeredBy',
  unrecognized: 'answers with an unrecognized answeredBy',
  nonCurrentGap: 'answers to a non-current gap',
} as const;
type Group = keyof typeof GROUPS;

const ABBREVIATED_HASH = 12;
const OCCUPANT_AGENT_PREFIX = 'owner-seat-';

/** `gap=a,premise=b,audit=c`: cada papel não citado fica com o próprio nome; `undefined` quando não vale. */
function parseTypes(raw: string | undefined): Types | undefined {
  const types: Types = { gap: 'gap', premise: 'premise', audit: 'audit' };
  for (const item of isUndefined(raw) ? [] : raw.split(',')) {
    const [role, value, ...rest] = item.split('=');
    const name = Name.safeParse(value);
    if (!ROLES.includes(role as Role) || rest.length > 0 || !name.success) return undefined;
    types[role as Role] = name.data;
  }
  return types;
}

function recordsOf(
  query: QueryService,
  project: Name,
  processName: Name | undefined,
  type: Name,
): QueryRecord[] {
  // chamada única, como o `timeline`: o teto de 64 MiB por processo limita a memória
  return query.queryRecords({
    project,
    ...(isUndefined(processName) ? { scope: 'project' as const } : { process: processName }),
    type,
    relations: 'full',
    limit: Number.MAX_SAFE_INTEGER,
  }).records;
}

/** Papel sem registro só vale como "nada a auditar" se o tipo existe no projeto; senão recusa. */
function assertTypesDefined(
  query: QueryService,
  project: Name,
  types: Types,
  emptyRoles: Role[],
): void {
  const defined = new Set(query.list({ project }).project?.types.map(({ name }) => name));
  const missing = emptyRoles.filter((role) => !defined.has(types[role]));
  if (missing.length === 0) return;
  throw invalidInput(
    '/types',
    'unknown-type',
    `type not defined in the project: ${missing.map((role) => `${role}=${types[role]}`).join(', ')}`,
  );
}

function textOf(record: QueryRecord, key: string): string | undefined {
  const value = record.data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function quoted(value: string | undefined): string {
  return isUndefined(value) ? '-' : JSON.stringify(value);
}

function whoOf({ author }: QueryRecord): string {
  return `agent=${quoted(author.agent)}  model=${quoted(author.model)}  client=${quoted(author.client)}`;
}

function sameAuthor(a: QueryRecord, b: QueryRecord): boolean {
  return a.author.agent === b.author.agent && a.author.client === b.author.client;
}

/** Os motivos de a resposta simulada não ter critério, lidos só do registro. */
function missingCriteria(answer: QueryRecord): string[] {
  const basis = textOf(answer, 'basis');
  if (basis === 'judgment') return ['basis judgment'];
  if (isUndefined(basis)) return ['basis missing'];
  if (basis !== 'rule') return [`basis unrecognized ${JSON.stringify(basis)}`];
  return [
    ...(isUndefined(textOf(answer, 'rule')) ? ['rule missing'] : []),
    ...(isUndefined(textOf(answer, 'criteria')) ? ['criteria missing'] : []),
  ];
}

function groupOf(answer: QueryRecord, isAudited: boolean): Group {
  const answeredBy = textOf(answer, 'answeredBy');
  if (answeredBy === 'human') return 'human';
  if (isUndefined(answeredBy)) return 'unattributed';
  if (answeredBy !== 'simulated') return 'unrecognized';
  if (missingCriteria(answer).length > 0) return 'withoutCriteria';
  return isAudited ? 'audited' : 'notAudited';
}

function answerLine(answer: QueryRecord, audit: QueryRecord | undefined): string {
  const group = groupOf(answer, !isUndefined(audit));
  const reasons = group === 'withoutCriteria' ? missingCriteria(answer) : [];
  const humanByOccupant =
    group === 'human' && answer.author.agent.startsWith(OCCUPANT_AGENT_PREFIX);
  return [
    `${answer.id}  ${answer.target}  ${whoOf(answer)}`,
    `rule=${quoted(textOf(answer, 'rule'))}`,
    `criteria=${quoted(textOf(answer, 'criteria')?.slice(0, ABBREVIATED_HASH))}`,
    `action=${quoted(textOf(answer, 'actionUsed'))}`,
    `answeredBy=${quoted(textOf(answer, 'answeredBy'))}`,
    ...(reasons.length > 0 ? [`(no criteria: ${reasons.join(', ')})`] : []),
    ...(humanByOccupant ? ['(agent is an owner-seat occupant)'] : []),
    ...(isUndefined(audit)
      ? []
      : [
          `[audited by ${whoOf(audit)} ${audit.id}${sameAuthor(answer, audit) ? ' (same author as the answer)' : ''}]`,
        ]),
  ].join('  ');
}

function gapLine(gap: QueryRecord): string {
  return `${gap.id}  ${gap.target}  ${whoOf(gap)}  question=${JSON.stringify(textOf(gap, 'question') ?? '')}`;
}

function buildLines(gaps: QueryRecord[], premises: QueryRecord[], audits: QueryRecord[]) {
  const auditById = new Map(audits.map((audit) => [audit.id, audit]));
  const lines: Record<Group, string[]> = {
    withoutCriteria: [],
    openGaps: gaps
      .filter(({ in: incoming = [] }) => !incoming.some((r) => r.kind === 'answers' && r.current))
      .map(gapLine),
    notAudited: [],
    audited: [],
    human: [],
    unattributed: [],
    unrecognized: [],
    nonCurrentGap: [],
  };
  const answers = premises.filter(({ out = [] }) => out.some((r) => r.kind === 'answers'));
  for (const answer of answers) {
    const edge = (answer.in ?? []).find(
      (r) => r.kind === 'supports' && r.current && auditById.has(r.from),
    );
    const audit = isUndefined(edge) ? undefined : auditById.get(edge.from);
    const answersCurrentGap = (answer.out ?? []).some(
      (r) => r.kind === 'answers' && r.current !== false,
    );
    const group = answersCurrentGap ? groupOf(answer, !isUndefined(audit)) : 'nonCurrentGap';
    lines[group].push(answerLine(answer, audit));
  }
  return lines;
}

function renderReport(lines: Record<Group, string[]>): string {
  const order: Group[] = [
    'withoutCriteria',
    'openGaps',
    'notAudited',
    'audited',
    'human',
    'unattributed',
    'unrecognized',
    'nonCurrentGap',
  ];
  const blocks = order.map((group) => {
    const body = lines[group].length === 0 ? ['  none'] : lines[group].map((line) => `  ${line}`);
    return [`${GROUPS[group]} (${lines[group].length})`, ...body].join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

function main(argv: string[]): number {
  const args = parseCliArgs(argv, { process: { type: 'string' }, types: { type: 'string' } });
  const [projectArg, ...extra] = args?.positionals ?? [];
  if (isNil(args) || isNil(projectArg) || extra.length > 0) {
    console.error(`seat-report failed: ${USAGE}`);
    return 1;
  }
  const project = Name.safeParse(projectArg);
  const processArg = args.values.process;
  const scope = isUndefined(processArg) ? undefined : Name.safeParse(processArg);
  const types = parseTypes(args.values.types);
  if (!project.success || (scope && !scope.success) || isUndefined(types)) {
    console.error(
      'seat-report failed: INVALID_INPUT: project, process and --types names must be valid',
    );
    return 1;
  }

  try {
    const { query } = openReadOnly();
    const byRole = ROLES.map((role) => recordsOf(query, project.data, scope?.data, types[role]));
    const emptyRoles = ROLES.filter((_, index) => byRole[index]?.length === 0);
    assertTypesDefined(query, project.data, types, emptyRoles);
    const [gaps, premises, audits] = byRole as [QueryRecord[], QueryRecord[], QueryRecord[]];
    process.stdout.write(escapeControls(renderReport(buildLines(gaps, premises, audits))));
    return 0;
  } catch (error) {
    return reportCliError('seat-report', error);
  }
}

process.exitCode = main(process.argv.slice(2));
