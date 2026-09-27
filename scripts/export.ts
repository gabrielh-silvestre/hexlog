// Exportação read-only de eventos em JSONL (Leva 8, #20).
// Uso: node scripts/export.ts <project>/<process> [--fields a,b,c]
import { isNil, isNotNil } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { isValidLink } from '../src/chain.ts';
import { loadProcess } from '../src/definitions.ts';
import { dataDir } from '../src/directory.ts';
import type { HexlogError } from '../src/errors.ts';
import { EventLineField, projectFields } from '../src/events.ts';
import { readText } from '../src/log.ts';

const USAGE = 'usage: node scripts/export.ts <project>/<process> [--fields a,b,c]';

function parseFields(raw: string | undefined): EventLineField[] | null {
  if (isNil(raw)) return null;
  const fields = raw.split(',').map((field) => field.trim());
  const invalid = fields.filter((field) => !EventLineField.safeParse(field).success);
  if (!isEmpty(invalid)) {
    throw new Error(
      `invalid field(s): ${invalid.join(', ')} (allowed: ${EventLineField.options.join(', ')})`,
    );
  }
  return fields as EventLineField[];
}

function main(target: string | undefined, fieldsArg: string | undefined): number {
  const [project, processName] = target?.split('/') ?? [];
  if (isNil(project) || isNil(processName)) {
    console.error(`export failed: ${USAGE}`);
    return 1;
  }

  let fields: EventLineField[] | null;
  try {
    fields = parseFields(fieldsArg);
  } catch (error) {
    console.error(`export failed: ${(error as Error).message}`);
    return 1;
  }

  try {
    const loaded = loadProcess(dataDir(process.env), project, processName);
    const text = readText(loaded.eventsFile);
    const events = text.split('\n').slice(0, -1).map(isValidLink).filter(isNotNil);
    const lines = isNil(fields) ? events : events.map((event) => projectFields(event, fields));
    for (const line of lines) console.log(JSON.stringify(line));
    return 0;
  } catch (error) {
    const { code, message } = error as HexlogError;
    console.error(`export failed: ${code ?? 'ERROR'}: ${message}`);
    return 1;
  }
}

const args = process.argv.slice(2);
const fieldsFlagIndex = args.indexOf('--fields');
const fieldsArg = fieldsFlagIndex === -1 ? undefined : args[fieldsFlagIndex + 1];

process.exitCode = main(args[0], fieldsArg);
