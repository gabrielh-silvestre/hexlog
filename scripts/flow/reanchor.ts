// Reancora as decisões vigentes na geração nova das diretrizes: `node scripts/flow/reanchor.ts --to
// directives-<N> [--apply]`. Sem `--apply` só lê e imprime o plano; com `--apply` grava, por
// `writer.ts#openWriter`, só as decisões de âncoras idênticas e confere o log relido. Precisa de
// `node_modules`. Sai 0 concluído, 1 recusa, lote recusado ou conferência divergente, e 2 para dado
// 0.x ou log quebrado. Só este script usa `import.meta.dirname`: é a raiz do checkout que a trava
// de código instalado compara com o commit do build.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isUndefined } from 'es-toolkit';
import { dataDir } from '../../src/directory.ts';
import { Name } from '../../src/domain/ids.ts';
import { VERSION } from '../../src/version.ts';
import { formatCliError, openReadOnly, parseCliArgs } from '../cli-error.ts';
import {
  formatPlan,
  generationOf,
  isCurrent,
  isLatestGeneration,
  planReanchor,
  processOf,
  toBatches,
  verifyReanchor,
  type DecisionRow,
  type LogRow,
  type Source,
} from './reanchor-plan.ts';
import { checkInstalled, gitDiffQuiet, openWriter } from './writer.ts';

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

function installedCheck() {
  return {
    version: VERSION,
    // Arquivo ausente ou ilegível vira `null`, que `checkInstalled` relata como problema.
    claudeJsonText: (() => {
      try {
        return fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
      } catch {
        return null;
      }
    })(),
    readManifest: (versionDir: string) => {
      try {
        return fs.readFileSync(path.join(versionDir, 'manifest.json'), 'utf8');
      } catch {
        return null;
      }
    },
    gitDiffQuiet: gitDiffQuiet(path.resolve(import.meta.dirname, '../..')),
  };
}

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
    decisions.push(
      ...rows.filter(isCurrent).map(({ id, target, data, out, in: incoming }) => ({
        process,
        id,
        target,
        data,
        out,
        in: incoming,
        lineage,
      })),
    );
  }
  return { decisions, before };
}

/** Grava os lotes processo a processo; devolve as regravações gravadas e se algum lote foi recusado. */
async function applyBatches(
  batchesByProcess: Map<string, ReturnType<typeof toBatches>>,
  rewritesByProcess: Map<string, Rewrite[]>,
  write: ReturnType<typeof openWriter>['write'],
) {
  const written: Rewrite[] = [];
  let refused = false;
  for (const [process, batches] of batchesByProcess) {
    let offset = 0;
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
      const count = batch.records.length;
      written.push(...(rewritesByProcess.get(process) ?? []).slice(offset, offset + count));
      offset += count;
    }
  }
  return { written, refused };
}

async function run(to: string, apply: boolean): Promise<number> {
  const reader = openReadOnly();
  const names = (reader.query.list({ project: PROJECT }).project?.processes ?? []).map(
    ({ name }) => name,
  );
  if (!isLatestGeneration(to, names)) {
    console.error(`flow reanchor failed: ${to} is not the latest directives generation listed`);
    return 1;
  }
  const latest = generationOf(to) ?? 0;
  const generations = names.filter((name) => GENERATION_NAME.test(name));
  const { decisions, before } = readWork(
    reader,
    names.filter((name) => !GENERATION_NAME.test(name)).sort(),
  );
  const older = Object.fromEntries(
    generations
      .filter((name) => (generationOf(name) ?? latest) < latest)
      .map((name) => [name, readSources(reader, name, true)]),
  );
  const plan = planReanchor({ to, decisions, older, current: readSources(reader, to, false) });
  const rewritesByProcess = Map.groupBy(plan.rewrites, ({ process }) => process);
  const batchesByProcess = new Map(
    [...rewritesByProcess].map(([process, rewrites]) => [
      process,
      toBatches(
        process,
        to,
        rewrites.map(({ item }) => item),
      ),
    ]),
  );

  const installed = installedCheck();
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
  const { written, refused } = await applyBatches(
    batchesByProcess,
    rewritesByProcess,
    writer.write,
  );

  const after = [...new Set(written.map(({ process }) => process))].flatMap((process) =>
    readRows(openReadOnly(), process, { type: 'decision', includeNonCurrent: true }),
  );
  const divergences = verifyReanchor(written, before, after);
  console.log(`rewrote ${written.length} of ${plan.rewrites.length} decisions`);
  for (const { id, problem } of divergences) console.error(`verify failed: ${id}: ${problem}`);
  return refused || divergences.length > 0 ? 1 : 0;
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
    const { text, exitCode } = formatCliError('flow reanchor', error);
    console.error(text);
    return exitCode;
  }
}

process.exitCode = await main(process.argv.slice(2));
