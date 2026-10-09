// Timeline read-only de targets: consulta de alcance projeto pelo `composeReader`, com os registros
// não vigentes e as relações. A cadeia de todos os processos do projeto é verificada na leitura
// (adulterada, o script sai com 2), e anexo ausente ou corrompido também sai com 2. A saída escapa
// os controles de terminal (`escapeControls`); `--raw` imprime o byte exato.
// Uso: node scripts/timeline.ts <project> <target-prefix>... [--full] [--json] [--raw]
import { isNil, isUndefined } from 'es-toolkit';
import { formatCliError, openReadOnly, parseCliArgs } from './cli-error.ts';
import { escapeControls } from './escape-controls.ts';
import { Name, Target, type Hash } from '../src/domain/ids.ts';
import type { QueryRecord, QueryService } from '../src/queries/query-service.ts';

const USAGE =
  'usage: node scripts/timeline.ts <project> <target-prefix>... [--full] [--json] [--raw]';

type Entry = { record: QueryRecord; texts: Record<Hash, string> };
type Section = { target: string; entries: Entry[] };

function recordsOf(query: QueryService, project: string, target: string): QueryRecord[] {
  // chamada única: cada página refaria a leitura e a verificação do log inteiro (custo quadrático).
  // O teto de 64 MiB vale por processo e o alcance projeto soma todos eles (limite listado para a F8)
  return query.queryRecords({
    project,
    scope: 'project',
    targetPrefix: target,
    includeNonCurrent: true,
    limit: Number.MAX_SAFE_INTEGER,
  }).records;
}

/**
 * Só os anexos `ok` têm texto a ler (inteiro, numa chamada: `maxChars` sem teto); os outros aparecem
 * pelo status. `cache` guarda o texto por hash: o mesmo anexo citado de novo não é relido.
 */
function textsOf(
  query: QueryService,
  project: string,
  record: QueryRecord,
  cache: Map<Hash, string>,
): Record<Hash, string> {
  const cited = Object.entries(record.attachmentStatus ?? {});
  return Object.fromEntries(
    cited
      .filter(([, status]) => status === 'ok')
      .map(([hash]) => {
        const cached = cache.get(hash);
        if (!isUndefined(cached)) return [hash, cached];
        const { text } = query.readAttachment({
          project,
          hash,
          maxChars: Number.MAX_SAFE_INTEGER,
        });
        cache.set(hash, text);
        return [hash, text];
      }),
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
    `${[record.at, record.id, record.type, JSON.stringify(record.author.agent)].join('  ')}${markOf(record)}`,
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
  const args = parseCliArgs(argv, {
    full: { type: 'boolean' },
    json: { type: 'boolean' },
    raw: { type: 'boolean' },
  });
  const [projectArg, ...targetArgs] = args?.positionals ?? [];
  if (isNil(args) || isNil(projectArg) || targetArgs.length === 0) {
    console.error(`timeline failed: ${USAGE}`);
    return 1;
  }
  const project = Name.safeParse(projectArg);
  if (!project.success || targetArgs.some((target) => !Target.safeParse(target).success)) {
    console.error('timeline failed: INVALID_INPUT: project and targets must be valid names');
    return 1;
  }
  const { full = false, json = false, raw = false } = args.values;

  try {
    const { query } = openReadOnly();
    const attachmentTexts = new Map<Hash, string>();
    const sections = targetArgs.map((target): Section => ({
      target,
      entries: recordsOf(query, project.data, target).map((record) => ({
        record,
        texts: full ? textsOf(query, project.data, record, attachmentTexts) : {},
      })),
    }));
    const output = json ? renderJson(sections, full) : renderText(sections);
    process.stdout.write(raw ? output : escapeControls(output));
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
