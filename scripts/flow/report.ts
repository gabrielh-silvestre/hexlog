// Relatório das decisões de um trabalho cuja base merece revisão: `node scripts/flow/report.ts
// <slug> [<base>]`. Motivos: `only-objective`, `only-sentinel`, `doc-amended`, `critical-gap`
// (freio do aval da cadeira do dono, segura o `mark`), `critical-gap-review` (só pede o julgamento
// da review, não segura o `mark`), `critical-doc-touched` (doc crítico no diff sem lacuna crítica,
// também não segura o `mark`) e `rests-on-simulated`. Só aponta, imprime e sai sempre 0; quem
// corrige é a skill `flow-run`. Lê o log apenas pelo `composeReader`
// (`scripts/cli-error.ts#openReadOnly`), nunca o diretório de dados; por isso precisa de
// `node_modules`, ao contrário do hook `flow-hooks.ts`.
// O `git` roda em `process.cwd()`, não na raiz do script, e o log vem de `openReadOnly`, também por
// cwd e `XDG_DATA_HOME`: o spec aponta os dois para um repositório e um diretório de dados
// temporários, e trocar o cwd quebraria o spec.
// As regex `SLUG` e `BASE` só validam o argv, que o shell já expandiu: protegem o script e nada
// executa o argv; o que sobra cai em `hooks-sao-freios` (`docs/directives/estrategia.md`).
import { spawnSync } from 'node:child_process';
import { Name, RecordId } from '../../src/domain/ids.ts';
import { HexlogError } from '../../src/errors.ts';
import type { QueryInput } from '../../src/queries/query-service.ts';
import { formatCliError, openReadOnly } from '../cli-error.ts';
import { isCurrent } from './sync.ts';

const PROJECT = Name.parse('hexlog');
const SENTINEL = 'directives.estrategia.none';
const DEFAULT_BASE = 'origin/develop';
const MAX_LINES = 100;
const MAX_UNCITED = 10;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BASE = /^[\w./-]+$/;
const USAGE = 'usage: node scripts/flow/report.ts <slug> [<base>]';

// Tolerante de propósito: o freio erra para o falso positivo (ADR 0012, item 5).
const CRITICAL_CLASS = /^\s*class:\s*critical\b/i;
// Só segmentos válidos de `Name`: o byte de controle de um `context` não chega ao stdout.
const CRITICAL_RULE = /; rule: ([a-z0-9][a-z0-9.-]*)/;
const CRITICAL_DOC =
  /^docs\/directives\/(adr-[a-z0-9-]+|invariantes|fronteiras|convencoes|estrategia)\.md$/;
const APPROVED_ORIGINS = new Set(['human', 'simulated-approved']);

type Relation = { kind: string; as?: string; to?: string; from?: string; current?: boolean };
type LinkedRelation = Relation & { to: string };
type Row = {
  id: string;
  type?: string;
  target: string;
  at?: string;
  data?: Record<string, unknown>;
  in: Relation[];
  out: Relation[];
  inheritedOut: Relation[];
};
/** Docs alterados no diff contra o merge-base e o instante do último commit da base..HEAD que tocou um deles. */
type Amendments = { docs: Set<string>; committedAt: (file: string) => number | undefined };

const warn = (message: string): void => void process.stderr.write(`flow-report: ${message}\n`);

/** Registros do filtro, inclusive os não vigentes, como `scripts/export.ts`; lança com o erro do servidor se a leitura falhar. */
function readRows(filter: Pick<QueryInput, 'process' | 'scope' | 'ids'>): Row[] {
  try {
    const { records } = openReadOnly().query.queryRecords({
      project: PROJECT,
      ...filter,
      includeNonCurrent: true,
      relations: 'full',
      limit: Number.MAX_SAFE_INTEGER,
    });
    return records.map(
      ({ id, type, target, at, data, in: incoming = [], out = [], inheritedOut = [] }) => ({
        id,
        type,
        target,
        at,
        data,
        in: incoming,
        out,
        inheritedOut,
      }),
    );
  } catch (error) {
    throw new Error(formatCliError('export', error).text, { cause: error });
  }
}

const exportRows = (proc: string): Row[] => readRows({ process: Name.parse(proc) });

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

/** Alterações em `docs/directives/` contra o merge-base com `base`; `undefined` se o git falhar. */
function amendments(base: string): Amendments | undefined {
  const mergeBase = tryGit(process.cwd(), ['merge-base', 'HEAD', base]);
  // Saída vazia do merge-base é falha, nunca "diff vazio".
  const diff = mergeBase ? tryGit(process.cwd(), ['diff', '--name-only', mergeBase]) : undefined;
  if (!mergeBase || diff === undefined) {
    // O prefixo `git:` fica: a skill `flow-audit` filtra o aviso por ele.
    warn(`git: cannot diff HEAD against "${base}", doc-amended skipped`);
    return undefined;
  }
  // ponytail: %cI é a data do committer, em segundos; rebase ou --amend acusam "amended after the
  // approval" (pede novo aval) e emenda não commitada é invisível; %aI trocaria falso positivo
  // recuperável por falso negativo silencioso
  const committedAt = (file: string): number | undefined => {
    const date = tryGit(process.cwd(), [
      'log',
      '-1',
      '--format=%cI',
      `${mergeBase}..HEAD`,
      '--',
      file,
    ]);
    const time = Date.parse(date ?? '');
    return Number.isNaN(time) ? undefined : time;
  };
  // ponytail: arquivo novo não rastreado fica fora do diff; versionar antes de rodar
  return { docs: new Set(diff.split('\n')), committedAt };
}

/** `docs/directives/<doc>.md` de um target `directives.<doc>.<regra>`. */
function docOf(target: string): string | undefined {
  const doc = /^directives\.([a-z0-9-]+)\./.exec(target)?.[1];
  return doc === undefined ? undefined : `docs/directives/${doc}.md`;
}

function amendedReasons(
  row: Row,
  docs: Set<string> | undefined,
  targetOf: (id: string) => string | undefined,
): string[] {
  const reasons = relationsOf(row, 'anchored-in').flatMap((relation) => {
    const target = targetOf(relation.to);
    const file = target === undefined ? undefined : docOf(target);
    return target !== undefined && file !== undefined && docs?.has(file) === true
      ? [`doc-amended: ${file} (${target})`]
      : [];
  });
  return [...new Set(reasons)];
}

/** `answeredBy` de uma premissa; `undefined` para outro tipo, premissa anterior ao campo ou linha ausente. */
function answeredByOf(row: Row | undefined): string | undefined {
  const value = row?.type === 'premise' ? row.data?.answeredBy : undefined;
  return typeof value === 'string' ? value : undefined;
}

const contextOf = (gap: Row): string =>
  typeof gap.data?.context === 'string' ? gap.data.context : '';

const isApproved = (row: Row | undefined): boolean => APPROVED_ORIGINS.has(answeredByOf(row) ?? '');

/** Freio do aval: lacuna de classe crítica (literal `Class: critical; rule: <target>` no `context`). */
function criticalGapReasons(
  gap: Row,
  byId: Map<string, Row>,
  amended: Amendments | undefined,
  targetOf: (id: string) => string | undefined,
  answeredByPinned: boolean,
): string[] {
  const context = contextOf(gap);
  if (!CRITICAL_CLASS.test(context)) return [];
  const closers = gap.in.filter(
    (relation) =>
      (relation.as === 'fills-gap' || relation.as === 'closes-gap') && relation.current === true,
  );
  if (closers.length === 0) return ['critical-gap: open, approval pending'];

  const reasons = closers.flatMap(({ from = '' }) => {
    const answeredBy = answeredByOf(byId.get(from));
    const by = `closed by ${targetOf(from) ?? from}`;
    if (answeredBy === undefined) {
      // fechador `directive` não tem o campo; premissa sem ele, num processo que o fixa, é omissão
      return byId.get(from)?.type === 'premise' && answeredByPinned
        ? [`critical-gap: ${by} (answeredBy=none, field pinned)`]
        : [`critical-gap-review: ${by} (answeredBy=none)`];
    }
    return APPROVED_ORIGINS.has(answeredBy)
      ? []
      : [`critical-gap: ${by} (answeredBy=${answeredBy})`];
  });

  const rule = CRITICAL_RULE.exec(context)?.[1];
  const file = rule === undefined ? undefined : docOf(rule);
  if (file === undefined) {
    reasons.push('critical-gap: rule doc unknown');
  } else if (amended !== undefined) {
    // `human` decidiu outra coisa e não emenda o doc; só a emenda posterior ao aval o alcança
    const needsDiff = closers.some(({ from = '' }) => answeredByOf(byId.get(from)) !== 'human');
    if (needsDiff && !amended.docs.has(file)) {
      reasons.push(`critical-gap: ${file} not in the diff`);
    } else {
      // Emenda posterior ao aval: o texto avalizado pode não ser mais o do doc.
      const committedAt = amended.committedAt(file);
      const amendedAfterApproval = closers.some(({ from = '' }) => {
        const closer = byId.get(from);
        return (
          committedAt !== undefined &&
          isApproved(closer) &&
          Date.parse(closer?.at ?? '') < committedAt
        );
      });
      if (amendedAfterApproval) {
        reasons.push(`critical-gap: doc amended after the approval (${file})`);
      }
    }
  }
  return reasons;
}

/** Docs críticos no diff que nenhuma lacuna crítica vigente cobre; só aponta, nunca segura o `mark`. */
function touchedLines(gaps: Row[], amended: Amendments | undefined): string[] {
  const covered = new Set(
    gaps.flatMap((gap) => {
      const rule = CRITICAL_CLASS.test(contextOf(gap))
        ? CRITICAL_RULE.exec(contextOf(gap))?.[1]
        : undefined;
      return rule === undefined ? [] : [docOf(rule)];
    }),
  );
  return [...(amended?.docs ?? [])]
    .filter((file) => CRITICAL_DOC.test(file) && !covered.has(file))
    .sort()
    .map((file) => `-\t-\tcritical-doc-touched: ${file}`);
}

/** `decision` apoiada em premissa `simulated` que nenhuma `simulated-approved` vigente deriva; a de classe comum (com `fills-gap`) já fechou a lacuna e fica de fora. */
function simulatedReasons(row: Row, byId: Map<string, Row>): string[] {
  return relationsOf(row, 'rests-on').flatMap(({ to }) => {
    const premise = byId.get(to);
    if (premise === undefined || answeredByOf(premise) !== 'simulated') return [];
    if (relationsOf(premise, 'fills-gap').length > 0) return [];
    const approved = premise.in.some(
      (relation) =>
        relation.kind === 'derivesFrom' &&
        relation.current === true &&
        answeredByOf(byId.get(relation.from ?? '')) === 'simulated-approved',
    );
    return approved ? [] : [`rests-on-simulated: ${premise.target} has no simulated-approved`];
  });
}

const lineOf = (row: Row, reasons: string[]): string[] =>
  reasons.length > 0 ? [`${row.id}\t${row.target}\t${reasons.join('; ')}`] : [];

/**
 * `in` das lacunas críticas lido no projeto: o fechador `directive` vive em `directives-N`, outro
 * processo, e a leitura do processo do trabalho não o vê. Falha da leitura mantém o `in` do export.
 */
function withProjectRelations(gaps: Row[]): Row[] {
  const critical = gaps.filter((gap) => CRITICAL_CLASS.test(contextOf(gap)));
  if (critical.length === 0) return gaps;
  try {
    const wide = new Map(
      readRows({ scope: 'project', ids: critical.map((gap) => RecordId.parse(gap.id)) }).map(
        (row) => [row.id, row.in],
      ),
    );
    return gaps.map((gap) => ({ ...gap, in: wide.get(gap.id) ?? gap.in }));
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return gaps;
  }
}

/** Se o `premise` fixado no processo tem `answeredBy`; `TYPE_NOT_PINNED` conta como não fixado. */
function pinsAnsweredBy(slug: string): boolean {
  try {
    const { schema } = openReadOnly().query.describeType({
      project: PROJECT,
      type: Name.parse('premise'),
      process: Name.parse(slug),
    });
    const { properties } = schema;
    return typeof properties === 'object' && properties !== null && 'answeredBy' in properties;
  } catch (error) {
    if (!(error instanceof HexlogError && error.code === 'TYPE_NOT_PINNED')) {
      warn(error instanceof Error ? error.message : String(error));
    }
    return false;
  }
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
  const byId = new Map(rows.map((row) => [row.id, row]));
  const amended = amendments(base);
  const gaps = current.filter((row) => row.type === 'gap');
  const answeredByPinned =
    gaps.some((gap) => CRITICAL_CLASS.test(contextOf(gap))) && pinsAnsweredBy(slug);

  const decisionLines = decisions.flatMap((row) =>
    lineOf(
      row,
      [
        uncitedReason(citedTargets(row, targetOf), slug, deliveryPremises),
        ...amendedReasons(row, amended?.docs, targetOf),
        ...simulatedReasons(row, byId),
      ].filter((reason) => reason !== undefined),
    ),
  );
  const gapLines = withProjectRelations(gaps).flatMap((gap) =>
    lineOf(gap, criticalGapReasons(gap, byId, amended, targetOf, answeredByPinned)),
  );
  // As lacunas e os docs críticos vêm antes: são o freio, e o corte não pode levá-los primeiro.
  const lines = [...gapLines, ...touchedLines(gaps, amended), ...decisionLines];
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
