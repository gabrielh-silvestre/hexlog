// Sync de `docs/directives/` com o processo de diretrizes: `node scripts/flow/sync-cli.ts check
// --process directives-<N>` lista o estado de cada documento sem gravar; `plan --process
// directives-<N> [--apply]` recebe no stdin só as regras extraídas, valida os tetos, planeja por
// `sync.ts#planSync` e, com `--apply`, anexa os `.md`, grava os lotes por `writer.ts#openWriter` e
// confere o log relido. Precisa de `node_modules`. Lê os
// documentos a partir do cwd, que tem de ser a raiz do checkout deste script (senão recusa). Sai 0
// concluído, 1 recusa, lote recusado ou conferência divergente, e 2 para dado 0.x ou log quebrado.
// Aqui `import.meta.dirname` dá a raiz do checkout que a trava de código instalado compara com o
// commit do build.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isUndefined } from 'es-toolkit';
import { z } from 'zod';
import { dataDir } from '../../src/directory.ts';
import { Name } from '../../src/domain/ids.ts';
import { BatchItem } from '../../src/domain/record.ts';
import { formatCliError, openReadOnly, parseCliArgs, reportCliError } from '../cli-error.ts';
import { escapeControls } from '../escape-controls.ts';
import { isLatestGeneration } from './reanchor-plan.ts';
import {
  STRATEGY_DOC,
  parsePremises,
  planSync,
  sha256,
  validateExtracted,
  verifySync,
  type Excess,
  type ExtractedRule,
  type LogRow,
  type SyncInput,
  type SyncPlan,
  type VigentRule,
} from './sync.ts';
import { checkInstalled, openWriter, readInstalled } from './writer.ts';

const PROJECT = Name.parse('hexlog');
const GENERATION_NAME = /^directives-[0-9]+$/;
const USAGE =
  'usage: node scripts/flow/sync-cli.ts check --process directives-<N> | plan --process directives-<N> [--apply]';
const AUTHOR = { agent: 'flow-sync', client: 'hexlog-flow-sync' };
const DOCS_DIR = 'docs/directives';
// O nome em minúsculas também deixa de fora o `AGENTS.md`, que não é diretriz.
const DOC_FILE = /^([a-z0-9-]+)\.md$/;

type Reader = ReturnType<typeof openReadOnly>;
type Status = 'up-to-date' | 'changed' | 'new' | 'removed';

/** Documento do checkout (`bytes` ausente: o arquivo sumiu) com o que o log tem dele. */
type Doc = {
  slug: string;
  bytes: Buffer | undefined;
  current: SyncInput['current'];
  vigent: VigentRule[];
};

const DocData = z.looseObject({ source: z.string(), removed: z.boolean().optional() });
const RuleData = z.looseObject({
  rule: z.string().optional(),
  statement: z.string().optional(),
  section: z.string().default(''),
});
const StdinRules = z.record(
  z.string(),
  z
    .array(
      z.strictObject({
        slug: z.string(),
        rule: z.string(),
        section: z.string(),
        closes: z.array(z.string()).optional(),
        interpreted: z.boolean().optional(),
      }),
    )
    .nullable(),
);
type Stdin = z.infer<typeof StdinRules>;
type Planned = { doc: Doc; plan: SyncPlan };

/** Registros de `process` numa só chamada, com relações inteiras. */
function readRows(
  reader: Reader,
  generation: string,
  includeNonCurrent: boolean,
): (LogRow & { type: string })[] {
  const { records } = reader.query.queryRecords({
    project: PROJECT,
    process: Name.parse(generation),
    includeNonCurrent,
    relations: 'full',
    limit: Number.MAX_SAFE_INTEGER,
  });
  return records.map(({ id, type, target, data = {}, in: incoming = [], out = [] }) => ({
    id,
    type,
    target,
    data,
    in: incoming,
    out,
  }));
}

/** O `doc` e as regras vigentes de cada documento; o slug é o segmento depois de `directives.`. */
function readDocs(reader: Reader, generation: string, root: string): Doc[] {
  const current = new Map<string, NonNullable<SyncInput['current']>>();
  const vigent = new Map<string, VigentRule[]>();
  for (const { id, type, target, data, out } of readRows(reader, generation, false)) {
    const [, slug = '', ...rest] = target.split('.');
    if (type === 'doc') {
      const { source, removed } = DocData.parse(data);
      current.set(slug, { id, source, ...(removed === true && { removed }) });
    } else if (rest.length > 0) {
      const { rule, statement, section } = RuleData.parse(data);
      vigent.set(slug, [
        ...(vigent.get(slug) ?? []),
        { id, target, rule: rule ?? statement ?? '', section, out },
      ]);
    }
  }
  const files = fs
    .readdirSync(path.join(root, DOCS_DIR))
    .flatMap((file) => DOC_FILE.exec(file)?.[1] ?? []);
  const slugs = new Set([
    ...files,
    ...[...current].filter(([, doc]) => doc.removed !== true).map(([slug]) => slug),
  ]);
  return [...slugs].sort().map((slug) => ({
    slug,
    bytes: files.includes(slug)
      ? fs.readFileSync(path.join(root, DOCS_DIR, `${slug}.md`))
      : undefined,
    current: current.get(slug) ?? null,
    vigent: vigent.get(slug) ?? [],
  }));
}

function statusOf({ bytes, current }: Doc): Status {
  if (isUndefined(bytes)) return 'removed';
  if (current === null || current.removed === true) return 'new';
  return current.source === sha256(bytes) ? 'up-to-date' : 'changed';
}

/**
 * Regras do documento: `null` se o arquivo sumiu, as premissas do próprio arquivo em `estrategia`
 * e, nos demais, as do stdin. Devolve o problema em vez de regras quando falta a extração.
 */
function extractedOf(
  doc: Doc,
  stdin: Stdin,
): { rules: ExtractedRule[] | null } | { problem: string } {
  if (isUndefined(doc.bytes)) return { rules: null };
  if (doc.slug === STRATEGY_DOC) {
    const { rules, malformed } = parsePremises(doc.bytes.toString('utf8'));
    return malformed.length > 0
      ? { problem: `${doc.slug}: invalid premises:\n  - ${malformed.join('\n  - ')}` }
      : { rules };
  }
  // `hasOwn`: um documento chamado `constructor.md` não pode ler o `Object` pela cadeia de protótipos.
  const given = Object.hasOwn(stdin, doc.slug) ? stdin[doc.slug] : undefined;
  if (given === null) return { problem: `${doc.slug}: null extraction but the file exists` };
  if (!isUndefined(given)) return { rules: given };
  const status = statusOf(doc);
  return status === 'up-to-date'
    ? { rules: [] }
    : { problem: `${doc.slug}: ${status} document without extracted rules on stdin` };
}

/** `slug` e `duplicate-slug` não medem tamanho de texto: o `size` e o `max` deles têm outro sentido. */
function describeExcess(docSlug: string, { slug, field, size, max }: Excess): string {
  if (field === 'slug') return `${docSlug}: slug "${slug}" is not a valid target segment`;
  if (field === 'duplicate-slug') return `${docSlug}: slug "${slug}" appears ${size} times`;
  return `${docSlug}: ${slug}: ${field} has size ${size}, max ${max}`;
}

function formatPlan(plans: Planned[], mode: string): string {
  const lines = [`sync ${mode}`];
  for (const { doc, plan } of plans) {
    const records = plan.batches.reduce((sum, { records: batch }) => sum + batch.length, 0);
    lines.push(
      `${doc.slug}\t${plan.upToDate ? 'up-to-date' : `${records} records in ${plan.batches.length} batches`}`,
    );
    for (const { rule, gaps } of plan.warnings) {
      lines.push(`warning: reopens-gap ${doc.slug}.${rule}: ${gaps.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function check(reader: Reader, generation: string): number {
  for (const doc of readDocs(reader, generation, process.cwd())) {
    console.log(`${doc.slug}\t${statusOf(doc)}`);
  }
  return 0;
}

/** Grava os lotes na ordem do plano; o primeiro recusado interrompe o processo. */
async function applyBatches(
  plans: Planned[],
  generation: string,
  write: ReturnType<typeof openWriter>['write'],
) {
  const written: SyncPlan['batches'] = [];
  for (const { plan } of plans) {
    for (const batch of plan.batches) {
      try {
        await write({
          process: generation,
          key: batch.key,
          records: batch.records.map((record) => BatchItem.parse(record)),
        });
      } catch (error) {
        console.error(
          `batch refused: ${generation} ${batch.key}: ${formatCliError('register', error).text}`,
        );
        return { written, refused: true };
      }
      written.push(batch);
    }
  }
  return { written, refused: false };
}

/** Lê o stdin das regras extraídas; devolve o erro já formatado quando não vale. */
function readStdin(): { stdin: Stdin } | { error: string } {
  const text = fs.readFileSync(0, 'utf8').trim() || '{}';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { error: `stdin is not valid JSON: ${String(error)}` };
  }
  const parsed = StdinRules.safeParse(json);
  return parsed.success
    ? { stdin: parsed.data }
    : { error: `invalid stdin: ${z.prettifyError(parsed.error)}` };
}

/** Planeja cada documento; chave do stdin sem documento, extração faltando e excesso viram problema. */
function gatherPlans(docs: Doc[], stdin: Stdin): { plans: Planned[]; problems: string[] } {
  const known = new Set(docs.map(({ slug }) => slug));
  const problems = Object.keys(stdin)
    .filter((key) => !known.has(key))
    .map((key) => `stdin key "${key}" matches no document of ${DOCS_DIR}`);
  const plans: Planned[] = [];
  for (const doc of docs) {
    const extracted = extractedOf(doc, stdin);
    if ('problem' in extracted) {
      problems.push(extracted.problem);
      continue;
    }
    for (const excess of validateExtracted(doc.slug, extracted.rules ?? [])) {
      problems.push(describeExcess(doc.slug, excess));
    }
    const planned = planSync({
      docSlug: doc.slug,
      path: `${DOCS_DIR}/${doc.slug}.md`,
      hash: isUndefined(doc.bytes) ? '' : sha256(doc.bytes),
      current: doc.current,
      vigent: doc.vigent,
      extracted: extracted.rules,
    });
    if (!isUndefined(planned.error)) problems.push(`${doc.slug}: ${planned.error}`);
    plans.push({ doc, plan: planned });
  }
  return { plans, problems };
}

async function plan(reader: Reader, generation: string, apply: boolean): Promise<number> {
  const root = process.cwd();
  const read = readStdin();
  if ('error' in read) {
    console.error(`flow sync failed: ${escapeControls(read.error)}`);
    return 1;
  }
  const { plans, problems } = gatherPlans(readDocs(reader, generation, root), read.stdin);
  if (problems.length > 0) {
    console.error(
      `flow sync failed:\n${problems.map((problem) => `- ${escapeControls(problem)}`).join('\n')}`,
    );
    return 1;
  }

  const installed = readInstalled(path.resolve(import.meta.dirname, '../..'));
  const installProblems = checkInstalled(installed);
  console.log(formatPlan(plans, apply ? 'apply' : 'dry-run'));
  if (!apply) {
    for (const problem of installProblems) console.error(`warning: ${problem}`);
    if (installProblems.length === 0) console.log('install check: ok');
    return 0;
  }
  if (installProblems.length > 0) {
    console.error(
      `flow sync failed: installed code check:\n${installProblems.map((p) => `- ${p}`).join('\n')}`,
    );
    return 1;
  }
  const total = plans.reduce((sum, { plan: planned }) => sum + planned.batches.length, 0);
  if (total === 0) return 0;

  const writer = openWriter({
    dataDir: dataDir(process.env),
    cwd: root,
    author: AUTHOR,
    installed,
  });
  for (const { doc, plan: planned } of plans) {
    if (planned.batches.length === 0 || isUndefined(doc.bytes)) continue;
    const hash = writer.attach(`${DOCS_DIR}/${doc.slug}.md`);
    if (hash !== sha256(doc.bytes)) {
      console.error(`flow sync failed: ${doc.slug}: attach hash ${hash} differs from the file`);
      return 1;
    }
  }
  const { written, refused } = await applyBatches(plans, generation, writer.write);

  const divergences = verifySync(
    { upToDate: false, batches: written, warnings: [] },
    readRows(openReadOnly(), generation, true),
  );
  console.log(`wrote ${written.length} of ${total} batches`);
  for (const { target, problem } of divergences)
    console.error(`verify failed: ${target}: ${problem}`);
  return refused || divergences.length > 0 ? 1 : 0;
}

/** O código instalado é conferido contra o checkout do script e os documentos vêm do cwd: têm de ser o mesmo. */
function checkoutProblem(): string | undefined {
  const root = process.cwd();
  const scriptRoot = path.resolve(import.meta.dirname, '../..');
  if (fs.realpathSync(root) !== fs.realpathSync(scriptRoot)) {
    return `cwd ${root} is not the checkout of this script (${scriptRoot}): run from the repository root`;
  }
  return fs.existsSync(path.join(root, DOCS_DIR))
    ? undefined
    : `${DOCS_DIR} not found in ${root}: run from the repository root`;
}

async function run(mode: string, generation: string, apply: boolean): Promise<number> {
  const wrongCheckout = checkoutProblem();
  if (wrongCheckout !== undefined) {
    console.error(`flow sync failed: ${wrongCheckout}`);
    return 1;
  }
  const reader = openReadOnly();
  const names = (reader.query.list({ project: PROJECT }).project?.processes ?? []).map(
    ({ name }) => name,
  );
  if (!names.includes(generation)) {
    console.error(
      `flow sync failed: process ${generation} not found: stop and warn the owner (never create_process of directives-N)`,
    );
    return 1;
  }
  if (!isLatestGeneration(generation, names)) {
    console.error(`flow sync failed: ${generation} is not the latest directives generation listed`);
    return 1;
  }
  return mode === 'check' ? check(reader, generation) : plan(reader, generation, apply);
}

async function main(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv, { process: { type: 'string' }, apply: { type: 'boolean' } });
  const [mode, ...extra] = args?.positionals ?? [];
  const target = args?.values.process;
  const apply = args?.values.apply === true;
  if (
    isUndefined(args) ||
    isUndefined(target) ||
    extra.length > 0 ||
    !GENERATION_NAME.test(target) ||
    (mode !== 'plan' && !(mode === 'check' && !apply))
  ) {
    console.error(`flow sync failed: ${USAGE}`);
    return 1;
  }
  try {
    return await run(mode, target, apply);
  } catch (error) {
    return reportCliError('flow sync', error);
  }
}

process.exitCode = await main(process.argv.slice(2));
