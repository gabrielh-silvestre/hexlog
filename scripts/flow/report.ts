// Relatório das decisões de um trabalho cuja base merece revisão: `node scripts/flow/report.ts
// <slug> [<base>]`. Só aponta, imprime e sai sempre 0; quem corrige é a skill `flow-run`. Lê o log
// apenas pelo `composeReader` (`scripts/cli-error.ts#openReadOnly`), nunca o diretório de dados;
// por isso precisa de `node_modules`, ao contrário do hook `flow-hooks.ts`.
// O `git` roda em `process.cwd()`, não na raiz do script, e o log vem de `openReadOnly`, também por
// cwd e `XDG_DATA_HOME`: o spec aponta os dois para um repositório e um diretório de dados
// temporários, e trocar o cwd quebraria o spec.
// As regex `SLUG` e `BASE` só validam o argv, que o shell já expandiu: protegem o script e nada
// executa o argv; o que sobra cai em `hooks-sao-freios` (`docs/directives/estrategia.md`).
import { spawnSync } from 'node:child_process';
import { Name } from '../../src/domain/ids.ts';
import { formatCliError, openReadOnly } from '../cli-error.ts';

const PROJECT = Name.parse('hexlog');
const SENTINEL = 'directives.estrategia.none';
const DEFAULT_BASE = 'origin/develop';
const MAX_LINES = 100;
const MAX_UNCITED = 10;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BASE = /^[\w./-]+$/;
const USAGE = 'usage: node scripts/flow/report.ts <slug> [<base>]';

type Relation = { kind: string; as?: string; to?: string };
type LinkedRelation = Relation & { to: string };
type Row = {
  id: string;
  type?: string;
  target: string;
  in: Relation[];
  out: Relation[];
  inheritedOut: Relation[];
};

const warn = (message: string): void => void process.stderr.write(`flow-report: ${message}\n`);

/** Registros de `proc`, inclusive os não vigentes, como `scripts/export.ts`; lança com o erro do servidor se a leitura falhar. */
function exportRows(proc: string): Row[] {
  try {
    const { records } = openReadOnly().query.queryRecords({
      project: PROJECT,
      process: Name.parse(proc),
      includeNonCurrent: true,
      relations: 'full',
      limit: Number.MAX_SAFE_INTEGER,
    });
    return records.map(({ id, type, target, in: incoming = [], out = [], inheritedOut = [] }) => ({
      id,
      type,
      target,
      in: incoming,
      out,
      inheritedOut,
    }));
  } catch (error) {
    throw new Error(formatCliError('export', error).text, { cause: error });
  }
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
        byProcess.set(proc, new Map(exportRows(proc).map((r) => [r.id, r.target])));
      } catch (error) {
        warn(error instanceof Error ? error.message : String(error));
        byProcess.set(proc, null);
      }
    }
    return byProcess.get(proc)?.get(id);
  };
}

/** Relações gravadas e herdadas pela linhagem de `supersedes` (`inheritedOut`, só derivado na leitura). */
const relationsOf = (row: Row, alias: string): LinkedRelation[] =>
  [...row.out, ...row.inheritedOut].filter(
    (relation): relation is LinkedRelation => relation.as === alias && relation.to !== undefined,
  );

/**
 * Citações distintas por target; id sem target conta como citação distinta e desconhecida. Premissa
 * revogada continua contando: o relatório lê a citação gravada, não a vigência da premissa.
 */
function citedTargets(row: Row, targetOf: (id: string) => string | undefined): Set<string> {
  return new Set(
    relationsOf(row, 'rests-on').map((relation) => targetOf(relation.to) ?? `?${relation.to}`),
  );
}

function uncitedReason(
  cited: Set<string>,
  slug: string,
  deliveryPremises: string[],
): string | undefined {
  const objective = `${slug}.premise.objective`;
  const decorative = [objective, SENTINEL].filter((target) => cited.has(target));
  if (decorative.length === 0 || decorative.length !== cited.size) return undefined;
  const uncited = deliveryPremises.filter((target) => !cited.has(target));
  const shown = uncited.slice(0, MAX_UNCITED).join(',') || '-';
  const rest = uncited.length > MAX_UNCITED ? ` (+${uncited.length - MAX_UNCITED})` : '';
  const label = decorative.map((target) => (target === SENTINEL ? 'sentinel' : 'objective'));
  return `only-${label.join('+')}: uncited=${shown}${rest}`;
}

/** Docs de `docs/directives/` alterados no diff contra o merge-base com `base`; `undefined` se o git falhar. */
function amendedDocs(base: string): Set<string> | undefined {
  const mergeBase = tryGit(process.cwd(), ['merge-base', 'HEAD', base]);
  // Saída vazia do merge-base é falha, nunca "diff vazio".
  const diff = mergeBase ? tryGit(process.cwd(), ['diff', '--name-only', mergeBase]) : undefined;
  if (diff === undefined) {
    // O prefixo `git:` fica: a skill `flow-audit` filtra o aviso por ele.
    warn(`git: cannot diff HEAD against "${base}", doc-amended skipped`);
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
    const target = targetOf(relation.to);
    const doc = target?.split('.')[1];
    if (target === undefined || doc === undefined) return [];
    const file = `docs/directives/${doc}.md`;
    return docs?.has(file) === true ? [`doc-amended: ${file} (${target})`] : [];
  });
  return [...new Set(reasons)];
}

function report(slug: string, base: string): string[] {
  const rows = exportRows(slug);
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
}

main();
