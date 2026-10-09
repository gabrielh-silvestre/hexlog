// Exportação read-only dos registros de um processo em JSONL, lidos pelo `composeReader` (a cadeia é
// verificada na leitura; adulterada, o script sai com 2). Inclui os registros não vigentes.
// Uso: node scripts/export.ts <project>/<process> [--fields a,b,c]
import { difference, isNil, pick } from 'es-toolkit';
import { formatCliError, openReadOnly, parseCliArgs } from './cli-error.ts';
import { Name } from '../src/domain/ids.ts';
import type { QueryRecord } from '../src/queries/query-service.ts';

const USAGE = 'usage: node scripts/export.ts <project>/<process> [--fields a,b,c]';
const FIELDS = [
  'id',
  'type',
  'at',
  'target',
  'author',
  'data',
  'in',
  'out',
  'needsReview',
  'attachmentStatus',
] as const satisfies readonly (keyof QueryRecord)[];
type Field = (typeof FIELDS)[number];

/** `fields` só vale se `invalid` vier vazio. */
function parseFields(raw: string | undefined): { fields: Field[] | null; invalid: string[] } {
  if (isNil(raw)) return { fields: null, invalid: [] };
  const fields = raw.split(',').map((field) => field.trim());
  const invalid = difference(fields, FIELDS);
  return { fields: fields as Field[], invalid };
}

function main(argv: string[]): number {
  const args = parseCliArgs(argv, { fields: { type: 'string' } });
  const [target, ...extra] = args?.positionals ?? [];
  const [projectArg, processArg, ...rest] = target?.split('/') ?? [];
  const project = Name.safeParse(projectArg);
  const processName = Name.safeParse(processArg);
  if (
    isNil(args) ||
    extra.length > 0 ||
    !project.success ||
    !processName.success ||
    rest.length > 0
  ) {
    console.error(`export failed: ${USAGE}`);
    return 1;
  }

  const { fields, invalid } = parseFields(args.values.fields);
  if (invalid.length > 0) {
    console.error(
      `export failed: invalid field(s): ${invalid.join(', ')} (allowed: ${FIELDS.join(', ')})`,
    );
    return 1;
  }

  try {
    const { query } = openReadOnly();
    // chamada única: cada página refaria a leitura e a verificação do log inteiro (custo quadrático);
    // o teto de 64 MiB por processo limita a memória
    const { records } = query.queryRecords({
      project: project.data,
      process: processName.data,
      includeNonCurrent: true,
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (const record of records) {
      console.log(JSON.stringify(isNil(fields) ? record : pick(record, fields)));
    }
    return 0;
  } catch (error) {
    const { text, exitCode } = formatCliError('export', error);
    console.error(text);
    return exitCode;
  }
}

process.exitCode = main(process.argv.slice(2));
