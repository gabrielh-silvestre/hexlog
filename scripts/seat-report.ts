// Relatório read-only da auditoria da cadeira do dono: lê, pelo `composeReader`, os registros vigentes
// dos tipos `gap`, `premise` e `audit` e separa as respostas por quanto já foi auditado. Não lê anexo:
// a marca "sem critério" sai só do registro, e o hash do `criteria` aparece abreviado. Identifica as
// arestas pela espécie (`answers`, `supports`) e por `current`, então sobrevive ao mapeamento de nomes
// de `--types`. Aval é a aresta `supports` vigente que chega de um registro do tipo `audit`; o `audit`
// de retirada (carregador do `revokes`, sem essa aresta) não conta. Seções exclusivas, na ordem de
// precedência: cada registro aparece numa só. A saída escapa os controles de terminal (`escapeControls`),
// e todo valor controlado pelo agente (agent, model, rule, criteria, action, question) sai entre aspas
// por `JSON.stringify`, para não introduzir quebra de linha, TAB nem marca falsa de seção ou de aval.
// Limites reais: a resposta a uma lacuna superada some das seis seções, porque a aresta `answers` deixa
// de ser vigente; com `--process` só se enxergam as arestas do próprio processo, então a lacuna
// respondida a partir de outro processo aparece como aberta (o escopo projeto não tem o problema).
// Uso: node scripts/seat-report.ts <project> [--process <name>] [--types gap=<t>,premise=<t>,audit=<t>]
// Saída: 0 íntegro (com os achados listados); 2 dado 0.x ou log quebrado; 1 uso incorreto ou erro.
import { isNil, isUndefined } from 'es-toolkit';
import { openReadOnly, parseCliArgs, reportCliError } from './cli-error.ts';
import { escapeControls } from './escape-controls.ts';
import { Name } from '../src/domain/ids.ts';
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
} as const;
type Group = keyof typeof GROUPS;

const ABBREVIATED_HASH = 12;

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

function textOf(record: QueryRecord, key: string): string | undefined {
  const value = record.data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function quoted(value: string | undefined): string {
  return isUndefined(value) ? '-' : JSON.stringify(value);
}

function whoOf({ author }: QueryRecord): string {
  return `agent=${quoted(author.agent)}  model=${quoted(author.model)}`;
}

/** Os motivos de a resposta simulada não ter critério, lidos só do registro. */
function missingCriteria(answer: QueryRecord): string[] {
  const basis = textOf(answer, 'basis');
  if (basis === 'judgment') return ['basis judgment'];
  if (isUndefined(basis)) return ['basis missing'];
  return [
    ...(isUndefined(textOf(answer, 'rule')) ? ['rule missing'] : []),
    ...(isUndefined(textOf(answer, 'criteria')) ? ['criteria missing'] : []),
  ];
}

function groupOf(answer: QueryRecord, isAudited: boolean): Group {
  const answeredBy = textOf(answer, 'answeredBy');
  if (answeredBy === 'human') return 'human';
  if (answeredBy !== 'simulated') return 'unattributed';
  if (missingCriteria(answer).length > 0) return 'withoutCriteria';
  return isAudited ? 'audited' : 'notAudited';
}

function answerLine(answer: QueryRecord, audit: QueryRecord | undefined): string {
  const reasons =
    groupOf(answer, !isUndefined(audit)) === 'withoutCriteria' ? missingCriteria(answer) : [];
  return [
    `${answer.id}  ${answer.target}  ${whoOf(answer)}`,
    `rule=${quoted(textOf(answer, 'rule'))}`,
    `criteria=${quoted(textOf(answer, 'criteria')?.slice(0, ABBREVIATED_HASH))}`,
    `action=${quoted(textOf(answer, 'actionUsed'))}`,
    ...(reasons.length > 0 ? [`(no criteria: ${reasons.join(', ')})`] : []),
    ...(isUndefined(audit) ? [] : [`[audited by ${whoOf(audit)} ${audit.id}]`]),
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
  };
  const answers = premises.filter(({ out = [] }) =>
    out.some((r) => r.kind === 'answers' && r.current !== false),
  );
  for (const answer of answers) {
    const edge = (answer.in ?? []).find(
      (r) => r.kind === 'supports' && r.current && auditById.has(r.from),
    );
    const audit = isUndefined(edge) ? undefined : auditById.get(edge.from);
    lines[groupOf(answer, !isUndefined(audit))].push(answerLine(answer, audit));
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
    const [gaps, premises, audits] = ROLES.map((role) =>
      recordsOf(query, project.data, scope?.data, types[role]),
    ) as [QueryRecord[], QueryRecord[], QueryRecord[]];
    process.stdout.write(escapeControls(renderReport(buildLines(gaps, premises, audits))));
    return 0;
  } catch (error) {
    return reportCliError('seat-report', error);
  }
}

process.exitCode = main(process.argv.slice(2));
