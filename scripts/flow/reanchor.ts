// Reancora as decisões vigentes na geração nova das diretrizes: `node scripts/flow/reanchor.ts --to
// directives-<N> [--apply]`. Sem `--apply` só lê e imprime o plano; com `--apply` grava, por
// `writer.ts#openWriter`, só as decisões de âncoras idênticas e confere o log relido. Precisa de
// `node_modules`. Sai 0 concluído, 1 recusa, lote recusado ou conferência divergente, e 2 para dado
// 0.x ou log quebrado. Aqui `import.meta.dirname` dá a raiz do checkout que a trava de código
// instalado compara com o commit do build.
import * as path from 'node:path';
import { isUndefined } from 'es-toolkit';
import { dataDir } from '../../src/directory.ts';
import { Name, processOf } from '../../src/domain/ids.ts';
import { formatCliError, openReadOnly, parseCliArgs, reportCliError } from '../cli-error.ts';
import {
  formatPlan,
  generationOf,
  isLatestGeneration,
  planReanchor,
  summarizeApply,
  toBatches,
  type DecisionRow,
  type LogRow,
  type Source,
} from './reanchor-plan.ts';
import { isCurrent } from './sync.ts';
import { checkInstalled, openWriter, readInstalled } from './writer.ts';

const PROJECT = Name.parse('hexlog');
const GENERATION_NAME = /^directives-[0-9]+$/;
const USAGE = 'usage: node scripts/flow/reanchor.ts --to directives-<N> [--apply]';
const AUTHOR = { agent: 'flow-reanchor', client: 'hexlog-flow-reanchor' };

type Reader = ReturnType<typeof openReadOnly>;
type Rewrite = ReturnType<typeof planReanchor>['rewrites'][number];
type Row = LogRow & { type: string };

/**
 * Registros de `process` numa só chamada, como `report.ts#exportRows`, com relações inteiras; sem
 * `process`, os do projeto inteiro, o único alcance que traz as relações vindas de outro processo.
 */
function readRows(
  reader: Reader,
  process: string | undefined,
  filter: { type?: string; fields?: string[]; includeNonCurrent?: boolean },
): Row[] {
  const { type, ...rest } = filter;
  const { records } = reader.query.queryRecords({
    project: PROJECT,
    ...(isUndefined(process) ? { scope: 'project' as const } : { process: Name.parse(process) }),
    ...rest,
    ...(isUndefined(type) ? {} : { type: Name.parse(type) }),
    relations: 'full',
    limit: Number.MAX_SAFE_INTEGER,
  });
  return records.map(
    ({ id, type: recordType, target, data = {}, in: incoming = [], out = [] }) => ({
      id,
      type: recordType,
      target,
      data,
      in: incoming,
      out,
    }),
  );
}

/** `rule` da `directive` ou `statement` da `premise`; os outros tipos não têm texto. */
function sourceOf(row: Row): Source {
  const { rule, statement } = row.data;
  const text = [rule, statement].find((value) => typeof value === 'string');
  return {
    id: row.id,
    type: row.type,
    target: row.target,
    ...(isUndefined(text) ? {} : { text }),
    current: isCurrent(row),
  };
}

const readSources = (reader: Reader, process: string, includeNonCurrent: boolean): Source[] =>
  readRows(reader, process, { fields: ['rule', 'statement'], includeNonCurrent }).map(sourceOf);

/** Processos de trabalho com as decisões vigentes e todas as decisões (a base da conferência). */
function readWork(reader: Reader, names: string[]) {
  const decisions: DecisionRow[] = [];
  const before: LogRow[] = [];
  const rowsByProcess = Map.groupBy(
    readRows(reader, undefined, { type: 'decision', includeNonCurrent: true }),
    ({ id }) => processOf(id),
  );
  for (const process of names) {
    const rows = rowsByProcess.get(process) ?? [];
    before.push(...rows);
    const lineage =
      reader.query.list({ project: PROJECT, process: Name.parse(process) }).process
        ?.lineageInheritance === true;
    decisions.push(...rows.filter(isCurrent).map((row) => ({ ...row, process, lineage })));
  }
  return { decisions, before };
}

/** Grava os lotes processo a processo; devolve as regravações gravadas e se algum lote foi recusado. */
async function applyBatches(
  batchesByProcess: Map<string, ReturnType<typeof toBatches>>,
  write: ReturnType<typeof openWriter>['write'],
) {
  const written: Rewrite[] = [];
  let refused = false;
  for (const [process, batches] of batchesByProcess) {
    for (const batch of batches) {
      try {
        await write(batch);
      } catch (error) {
        refused = true;
        console.error(
          `batch refused: ${process} ${batch.key}: ${formatCliError('register', error).text}`,
        );
        break;
      }
      written.push(...batch.rewrites);
    }
  }
  return { written, refused };
}

async function run(to: string, apply: boolean): Promise<number> {
  const reader = openReadOnly();
  const names = (reader.query.list({ project: PROJECT }).project?.processes ?? []).map(
    ({ name }) => name,
  );
  const latest = generationOf(to);
  if (isUndefined(latest) || !isLatestGeneration(to, names)) {
    console.error(`flow reanchor failed: ${to} is not the latest directives generation listed`);
    return 1;
  }
  const { decisions, before } = readWork(
    reader,
    names.filter((name) => isUndefined(generationOf(name))).sort(),
  );
  const isOlder = (name: string) => {
    const generation = generationOf(name);
    return !isUndefined(generation) && generation < latest;
  };
  const older = Object.fromEntries(
    names.filter(isOlder).map((name) => [name, readSources(reader, name, true)]),
  );
  const plan = planReanchor({ to, decisions, older, current: readSources(reader, to, false) });
  const rewritesByProcess = Map.groupBy(plan.rewrites, ({ process }) => process);
  const batchesByProcess = new Map(
    [...rewritesByProcess].map(([process, rewrites]) => [
      process,
      toBatches(process, to, rewrites),
    ]),
  );

  const installed = readInstalled(path.resolve(import.meta.dirname, '../..'));
  const problems = checkInstalled(installed);
  console.log(formatPlan(plan, { to, apply }));
  if (!apply) {
    for (const problem of problems) console.error(`warning: ${problem}`);
    if (problems.length === 0) console.log('install check: ok');
    return 0;
  }
  if (problems.length > 0) {
    console.error(
      `flow reanchor failed: installed code check:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    );
    return 1;
  }
  if (plan.rewrites.length === 0) return 0;

  const writer = openWriter({
    dataDir: dataDir(process.env),
    cwd: process.cwd(),
    author: AUTHOR,
    installed,
  });
  const { written, refused } = await applyBatches(batchesByProcess, writer.write);

  const freshReader = openReadOnly();
  const after = [...new Set(written.map(({ process }) => process))].flatMap((process) =>
    readRows(freshReader, process, { type: 'decision', includeNonCurrent: true }),
  );
  const summary = summarizeApply({
    written,
    planned: plan.rewrites.length,
    refused,
    before,
    after,
  });
  for (const line of summary.out) console.log(line);
  for (const line of summary.err) console.error(line);
  return summary.code;
}

async function main(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv, { to: { type: 'string' }, apply: { type: 'boolean' } });
  const to = args?.values.to;
  if (
    isUndefined(args) ||
    isUndefined(to) ||
    args.positionals.length > 0 ||
    !GENERATION_NAME.test(to)
  ) {
    console.error(`flow reanchor failed: ${USAGE}`);
    return 1;
  }
  try {
    return await run(to, args.values.apply === true);
  } catch (error) {
    return reportCliError('flow reanchor', error);
  }
}

process.exitCode = await main(process.argv.slice(2));
