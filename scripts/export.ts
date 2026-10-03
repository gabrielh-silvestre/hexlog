// Exportação read-only dos registros de um processo em JSONL, lidos pelo `compose` (a cadeia é
// verificada na leitura; adulterada, o script sai com 2). Inclui os registros não vigentes.
// Uso: node scripts/export.ts <project>/<process> [--fields a,b,c]
import { isNil, pick } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { formatCliError } from './cli-error.ts';
import { compose } from '../src/compose.ts';
import { dataDir } from '../src/directory.ts';
import { Name } from '../src/domain/ids.ts';
import { legacyDataError } from '../src/errors.ts';
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

function main(target: string | undefined, fieldsArg: string | undefined): number {
  const [projectArg, processArg, ...rest] = target?.split('/') ?? [];
  const project = Name.safeParse(projectArg);
  const processName = Name.safeParse(processArg);
  if (!project.success || !processName.success || rest.length > 0) {
    console.error(`export failed: ${USAGE}`);
    return 1;
  }

  let fields: Field[] | null;
  try {
    fields = parseFields(fieldsArg);
  } catch (error) {
    console.error(`export failed: ${(error as Error).message}`);
    return 1;
  }

  try {
    const { services, isLegacy } = compose({
      dataDir: dataDir(process.env),
      cwd: process.cwd(),
      clock: () => new Date(),
      logger: () => undefined,
    });
    if (isLegacy()) throw legacyDataError();
    let cursor: string | undefined;
    do {
      const page = services.query.queryRecords({
        project: project.data,
        process: processName.data,
        includeNonCurrent: true,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        console.log(JSON.stringify(isNil(fields) ? record : pick(record, fields)));
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return 0;
  } catch (error) {
    const { text, exitCode } = formatCliError('export', error);
    console.error(text);
    return exitCode;
  }
}

const args = process.argv.slice(2);
const fieldsFlagIndex = args.indexOf('--fields');
const fieldsArg = fieldsFlagIndex === -1 ? undefined : args[fieldsFlagIndex + 1];

process.exitCode = main(args[0], fieldsArg);
