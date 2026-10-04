// Exportação read-only dos registros de um processo em JSONL, lidos pelo `composeReader` (a cadeia é
// verificada na leitura; adulterada, o script sai com 2). Inclui os registros não vigentes.
// Uso: node scripts/export.ts <project>/<process> [--fields a,b,c]
import { isNil, pick } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
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

function parseFields(raw: string | undefined): Field[] | null {
  if (isNil(raw)) return null;
  const fields = raw.split(',').map((field) => field.trim());
  const invalid = fields.filter((field) => !(FIELDS as readonly string[]).includes(field));
  if (!isEmpty(invalid)) {
    throw new Error(`invalid field(s): ${invalid.join(', ')} (allowed: ${FIELDS.join(', ')})`);
  }
  return fields as Field[];
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

  let fields: Field[] | null;
  try {
    fields = parseFields(args.values.fields);
  } catch (error) {
    console.error(`export failed: ${(error as Error).message}`);
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
