// Relatório das decisões de um trabalho cuja base merece revisão: `node .claude/hooks/flow-report.ts
// <slug> [<base>]`. Só aponta, imprime e sai sempre 0; quem corrige é a skill `flow-run`. Só
// builtins do Node, sem import fora de `.claude/hooks/`. Lê o log apenas pela exportação oficial
// (`scripts/export.ts` em processo filho), nunca o diretório de dados; por isso precisa de
// `node_modules`, ao contrário do `flow-hooks.ts`.
// A entrada de `allow` (`Bash(node .claude/hooks/flow-report.ts *)`) aceita argumento livre, então
// as duas regex abaixo são o freio.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const PROJECT = 'hexlog';
const SENTINEL = 'directives.estrategia.none';
const DEFAULT_BASE = 'origin/develop';
const MAX_LINES = 100;
const MAX_UNCITED = 10;
const MAX_BUFFER = 64 * 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BASE = /^[\w./-]+$/;
const USAGE = 'usage: node .claude/hooks/flow-report.ts <slug> [<base>]';

type Relation = { kind: string; as?: string; to?: string };
type Row = { id: string; type?: string; target: string; in: Relation[]; out: Relation[] };

const warn = (message: string): void => void process.stderr.write(`flow-report: ${message}\n`);

/** Linhas do `scripts/export.ts` de `proc`; lança com o stderr do filho se ele falhar. */
function exportRows(proc: string, fields: string): Row[] {
  const result = spawnSync(
    process.execPath,
    ['scripts/export.ts', `${PROJECT}/${proc}`, '--fields', fields],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => ({ in: [], out: [], ...(JSON.parse(line) as Partial<Row>) }) as Row);
}

/** Vigência como o servidor a vê (`src/domain/relations.ts#buildVigency`): sem `supersedes` nem `revokes` de entrada. */
const isCurrent = (row: Row): boolean =>
  !row.in.some((relation) => relation.kind === 'supersedes' || relation.kind === 'revokes');

/** `git <args>` em `cwd`; `undefined` se o git falhar. */
function tryGit(cwd: string, args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.error || result.status !== 0 ? undefined : result.stdout.trim();
}

/** Resolve id para target: primeiro o processo do trabalho, depois um export por prefixo (em cache, falha incluída). */
function createTargetOf(slug: string, own: Row[]): (id: string) => string | undefined {
  const byProcess = new Map<string, Map<string, string> | null>([
    [slug, new Map(own.map((row) => [row.id, row.target]))],
  ]);
  return (id) => {
    const proc = id.slice(0, Math.max(id.indexOf(':'), 0));
    if (!byProcess.has(proc)) {
      try {
        if (!SLUG.test(proc)) throw new Error(`cannot read the process of id "${id}"`);
        byProcess.set(proc, new Map(exportRows(proc, 'id,target').map((r) => [r.id, r.target])));
      } catch (error) {
        warn(error instanceof Error ? error.message : String(error));
        byProcess.set(proc, null);
      }
    }
    return byProcess.get(proc)?.get(id);
  };
}

const relationsOf = (row: Row, alias: string): Relation[] =>
  row.out.filter((relation) => relation.as === alias && relation.to !== undefined);

/** Citações distintas por target; id sem target conta como citação distinta e desconhecida. */
function citedTargets(row: Row, targetOf: (id: string) => string | undefined): Set<string> {
  return new Set(
    relationsOf(row, 'rests-on').map((relation) => {
      const id = relation.to ?? '';
      return targetOf(id) ?? `?${id}`;
    }),
  );
}

function uncitedReason(
  cited: Set<string>,
  slug: string,
  deliveryPremises: string[],
): string | undefined {
  const [only] = cited;
  if (cited.size !== 1 || (only !== `${slug}.premise.objective` && only !== SENTINEL)) {
    return undefined;
  }
  const uncited = deliveryPremises.filter((target) => !cited.has(target));
  const shown = uncited.slice(0, MAX_UNCITED).join(',') || '-';
  const rest = uncited.length > MAX_UNCITED ? ` (+${uncited.length - MAX_UNCITED})` : '';
  return `only-${only === SENTINEL ? 'sentinel' : 'objective'}: uncited=${shown}${rest}`;
}

/** Docs de `docs/directives/` alterados no diff contra o merge-base com `base`; `undefined` se o git falhar. */
function amendedDocs(base: string): Set<string> | undefined {
  const mergeBase = tryGit(process.cwd(), ['merge-base', 'HEAD', base]);
  // Saída vazia do merge-base é falha, nunca "diff vazio".
  const diff = mergeBase ? tryGit(process.cwd(), ['diff', '--name-only', mergeBase]) : undefined;
  if (diff === undefined) {
    warn(`git: no merge-base between HEAD and "${base}", doc-amended skipped`);
    return undefined;
  }
  // ponytail: arquivo novo não rastreado fica fora do diff; versionar antes de rodar
  return new Set(diff.split('\n'));
}

function amendedReasons(
  row: Row,
  docs: Set<string> | undefined,
  targetOf: (id: string) => string | undefined,
): string[] {
  const reasons = relationsOf(row, 'anchored-in').flatMap((relation) => {
    const target = targetOf(relation.to ?? '');
    const doc = target?.split('.')[1];
    const file = `docs/directives/${doc ?? ''}.md`;
    return target !== undefined && doc !== undefined && docs?.has(file) === true
      ? [`doc-amended: ${file} (${target})`]
      : [];
  });
  return [...new Set(reasons)];
}

function report(slug: string, base: string): string[] {
  const rows = exportRows(slug, 'id,type,target,in,out');
  const current = rows.filter(isCurrent);
  const decisions = current.filter((row) => row.type === 'decision');
  const deliveryPremises = [
    ...new Set(
      current
        .filter((row) => row.type === 'premise' && row.target.startsWith(`${slug}.premise.`))
        .map((row) => row.target),
    ),
  ];
  const targetOf = createTargetOf(slug, rows);
  const anchored = decisions.some((row) => relationsOf(row, 'anchored-in').length > 0);
  const docs = anchored ? amendedDocs(base) : undefined;

  const lines = decisions.flatMap((row) => {
    const reasons = [
      uncitedReason(citedTargets(row, targetOf), slug, deliveryPremises),
      ...amendedReasons(row, docs, targetOf),
    ].filter((reason) => reason !== undefined);
    return reasons.length > 0 ? [`${row.id}\t${row.target}\t${reasons.join('; ')}`] : [];
  });
  if (lines.length === 0) return ['nothing to flag'];
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `... ${lines.length - MAX_LINES} more omitted`];
}

function main(): void {
  const [, , slug, base = DEFAULT_BASE] = process.argv;
  try {
    if (slug === undefined || !SLUG.test(slug) || !BASE.test(base) || base.startsWith('-')) {
      throw new Error(USAGE);
    }
    process.stdout.write(`${report(slug, base).join('\n')}\n`);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 0;
}

main();
