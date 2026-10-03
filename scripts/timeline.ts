// Timeline read-only de targets: consulta de alcance projeto pelo `compose`, com os registros não
// vigentes e as relações. A cadeia de todos os processos do projeto é verificada na leitura
// (adulterada, o script sai com 2), e anexo ausente ou corrompido também sai com 2.
// Uso: node scripts/timeline.ts <project> <target-prefix>... [--full] [--json]
import { isNil } from 'es-toolkit';
import { formatCliError } from './cli-error.ts';
import { compose } from '../src/compose.ts';
import { dataDir } from '../src/directory.ts';
import { Name, Target, type Hash } from '../src/domain/ids.ts';
import { legacyDataError } from '../src/errors.ts';
import type { QueryRecord, QueryService } from '../src/queries/query-service.ts';

const USAGE = 'usage: node scripts/timeline.ts <project> <target-prefix>... [--full] [--json]';
const FLAGS = ['--full', '--json'];

type Entry = { record: QueryRecord; texts: Record<Hash, string> };
type Section = { target: string; entries: Entry[] };

function recordsOf(query: QueryService, project: string, target: string): QueryRecord[] {
  const records: QueryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = query.queryRecords({
      project,
      scope: 'project',
      targetPrefix: target,
      includeNonCurrent: true,
      ...(cursor === undefined ? {} : { cursor }),
    });
    records.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
}

/** Texto inteiro do anexo, página a página (`next` é o offset da página seguinte). */
function textOf(query: QueryService, project: string, hash: Hash): string {
  let text = '';
  let offset: number | undefined = 0;
  do {
    const page = query.readAttachment({ project, hash, offset });
    text += page.text;
    offset = page.next;
  } while (offset !== undefined);
  return text;
}

/** Só os anexos `ok` têm texto a ler; os outros aparecem pelo status. */
function textsOf(query: QueryService, project: string, record: QueryRecord): Record<Hash, string> {
  const cited = Object.entries(record.attachmentStatus ?? {});
  return Object.fromEntries(
    cited
      .filter(([, status]) => status === 'ok')
      .map(([hash]) => [hash, textOf(query, project, hash)]),
  );
}

function brokenAttachments(sections: Section[]): string[] {
  return sections.flatMap(({ entries }) =>
    entries.flatMap(({ record }) =>
      Object.entries(record.attachmentStatus ?? {})
        .filter(([, status]) => status !== 'ok')
        .map(
          ([hash, status]) =>
            `warning ATTACHMENT_${status.toUpperCase()}: record ${record.id} cites ${hash}`,
        ),
    ),
  );
}

function markOf({ in: incoming }: QueryRecord): string {
  const by = (kind: string) =>
    incoming.filter((relation) => relation.kind === kind).map((r) => r.from);
  const superseded = by('supersedes');
  const revoked = by('revokes');
  return [
    superseded.length > 0 ? `  [superseded by ${superseded.join(', ')}]` : '',
    revoked.length > 0 ? `  [revoked by ${revoked.join(', ')}]` : '',
  ].join('');
}

function renderEntry({ record, texts }: Entry): string {
  const lines = [
    `${[record.at, record.id, record.type, record.author.agent].join('  ')}${markOf(record)}`,
    `  target: ${record.target}`,
    `  data: ${JSON.stringify(record.data)}`,
    ...record.in.map(({ kind, from }) => `  in: ${kind} <- ${from}`),
    ...record.out.map(({ kind, to }) => `  out: ${kind} -> ${to}`),
  ];
  if (!isNil(record.needsReview))
    lines.push(`  needsReview: ${JSON.stringify(record.needsReview)}`);
  for (const [hash, status] of Object.entries(record.attachmentStatus ?? {})) {
    lines.push(`  attachment: ${hash} (${status})`);
    const text = texts[hash];
    // texto contíguo e idêntico entre os delimitadores: sem recuo, sem corte
    if (!isNil(text)) {
      lines.push(
        `----- attachment ${hash} (${Buffer.byteLength(text, 'utf8')} bytes) -----`,
        text,
        '----- end -----',
      );
    }
  }
  return lines.join('\n');
}

function renderText(sections: Section[]): string {
  const blocks = sections.map(({ target, entries }) =>
    [`target ${target}: ${entries.length} records`, ...entries.map(renderEntry)].join('\n\n'),
  );
  return `${blocks.join('\n\n')}\n`;
}

function renderJson(sections: Section[], full: boolean): string {
  return sections
    .flatMap(({ target, entries }) =>
      entries.map(({ record, texts }) => ({
        kind: 'record',
        query: target,
        ...record,
        ...(full ? { attachmentText: texts } : {}),
      })),
    )
    .map((line) => `${JSON.stringify(line)}\n`)
    .join('');
}

function main(argv: string[]): number {
  const [projectArg, ...targetArgs] = argv.filter((arg) => !arg.startsWith('--'));
  const flags = argv.filter((arg) => arg.startsWith('--'));
  if (isNil(projectArg) || targetArgs.length === 0 || flags.some((flag) => !FLAGS.includes(flag))) {
    console.error(`timeline failed: ${USAGE}`);
    return 1;
  }
  const project = Name.safeParse(projectArg);
  if (!project.success || targetArgs.some((target) => !Target.safeParse(target).success)) {
    console.error('timeline failed: INVALID_INPUT: project and targets must be valid names');
    return 1;
  }
  const full = flags.includes('--full');

  try {
    const { services, isLegacy } = compose({
      dataDir: dataDir(process.env),
      cwd: process.cwd(),
      clock: () => new Date(),
      logger: () => undefined,
    });
    if (isLegacy()) throw legacyDataError();
    const sections = targetArgs.map((target): Section => ({
      target,
      entries: recordsOf(services.query, project.data, target).map((record) => ({
        record,
        texts: full ? textsOf(services.query, project.data, record) : {},
      })),
    }));
    process.stdout.write(
      flags.includes('--json') ? renderJson(sections, full) : renderText(sections),
    );
    // avisos no stderr: o stdout do --json fica só com as linhas `record`
    const warnings = brokenAttachments(sections);
    for (const warning of warnings) console.error(warning);
    return warnings.length > 0 ? 2 : 0;
  } catch (error) {
    const { text, exitCode } = formatCliError('timeline', error);
    console.error(text);
    return exitCode;
  }
}

process.exitCode = main(process.argv.slice(2));
