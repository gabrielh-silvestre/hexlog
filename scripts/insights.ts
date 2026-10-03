// Relatório markdown read-only (integridade, linha do tempo e sinais da `key`) sobre os logs do hexlog.
// Uso: node scripts/insights.ts [projeto[/processo]]; diretório de dados via XDG_DATA_HOME.
// Saída 1: cadeia quebrada ou falha de leitura; saída 2: dado 0.x em <D> (D-13).
import { countBy, groupBy, head, isNil, last, orderBy, take, zip } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { formatCliError } from './cli-error.ts';
import { compose } from '../src/compose.ts';
import type { Link } from '../src/domain/chain.ts';
import { dataDir } from '../src/directory.ts';
import { legacyDataError } from '../src/errors.ts';

const TOP_GAPS = 3;
const TOP_SIGNALS = 5;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function timelineSection(records: Link[]): string[] {
  const first = head(records);
  const final = last(records);
  if (isNil(first) || isNil(final)) return ['- timeline: no records'];
  const pairs = zip(records.slice(0, -1), records.slice(1)).map(([from, to]) => ({
    ms: Date.parse(to.at) - Date.parse(from.at),
    from: from.seq,
    to: to.seq,
  }));
  const gaps = take(orderBy(pairs, [(gap) => gap.ms], ['desc']), TOP_GAPS);
  const perDay = countBy(records, (record) => record.at.slice(0, 10));
  const perType = countBy(records, (record) => record.type);
  return [
    `- first record: ${first.at}`,
    `- last record: ${final.at}`,
    `- total duration: ${formatDuration(Date.parse(final.at) - Date.parse(first.at))}`,
    '- records per day:',
    ...Object.entries(perDay).map(([day, count]) => `  - ${day}: ${count}`),
    '- records by type:',
    ...Object.entries(perType).map(([type, count]) => `  - ${type}: ${count}`),
    `- largest gaps (top ${TOP_GAPS}):`,
    ...gaps.map((gap) => `  - ${formatDuration(gap.ms)} between seq ${gap.from} and ${gap.to}`),
  ];
}

/**
 * Lote do log: o 1º elo da linha é o único que leva `batch` (D-04); o tipo do lote é o dele e
 * `size` conta os elos até o próximo lote.
 */
type BatchInfo = { seq: number; type: string; key?: string; fingerprint: string; size: number };

function batchesOf(records: Link[]): BatchInfo[] {
  const batches: BatchInfo[] = [];
  for (const { batch, seq, type } of records) {
    const current = batches.at(-1);
    if (batch !== undefined) {
      batches.push({ seq, type, key: batch.key, fingerprint: batch.fingerprint, size: 1 });
    } else if (current !== undefined) {
      current.size += 1;
    }
  }
  return batches;
}

function listed(label: string, entries: string[]): string[] {
  return [
    `  - ${label}: ${entries.length}`,
    ...take(entries, TOP_SIGNALS).map((entry) => `    - ${entry}`),
  ];
}

/**
 * SE8: sinais para calibrar onde a `key` vale. A impressão (`fingerprint`) de todo lote está na
 * cadeia, com ou sem `key`. Possível duplicata sem chave: lote sem `key` com a impressão de um lote
 * anterior do processo. Chave em excesso (G4): lote de 1 registro com `key` cuja impressão nenhum
 * outro lote do processo repete. É um proxy: o reenvio com a mesma `key` devolve `replayed` sem
 * gravar, então "nunca teve reenvio" não é observável no log.
 */
function keySection(batches: BatchInfo[]): string[] {
  if (isEmpty(batches)) return ['- key signals: no batches'];
  const firstOf = new Map<string, BatchInfo>();
  const duplicates: string[] = [];
  for (const batch of batches) {
    const original = firstOf.get(batch.fingerprint);
    if (original === undefined) firstOf.set(batch.fingerprint, batch);
    else if (batch.key === undefined) {
      duplicates.push(`seq ${batch.seq} repeats seq ${original.seq} (${batch.type})`);
    }
  }
  const occurrences = countBy(batches, (batch) => batch.fingerprint);
  const excess = batches
    .filter(
      (batch) =>
        batch.key !== undefined && batch.size === 1 && occurrences[batch.fingerprint] === 1,
    )
    .map((batch) => `seq ${batch.seq} (${batch.type})`);
  const perType = Object.entries(groupBy(batches, (batch) => batch.type)).map(([type, group]) => {
    const keyed = group.filter((batch) => batch.key !== undefined).length;
    return `    - ${type}: ${keyed}/${group.length} batches with key (${((keyed / group.length) * 100).toFixed(1)}%)`;
  });
  return [
    '- key signals:',
    ...listed('possible duplicates without key', duplicates),
    ...listed('keys in excess (proxy)', excess),
    '  - batches with key by type:',
    ...perType,
  ];
}

type Composed = ReturnType<typeof compose>;
type Report = { lines: string[]; ok: boolean };

function processReport(composed: Composed, project: string, processName: string): Report {
  const title = `## ${project}/${processName}`;
  try {
    const ref = { project, process: processName };
    const health = composed.services.query.verifyChain(ref);
    const { records } = composed.loadProcess(ref);
    const breaks = health.breaks.map((brk) => `${brk.reason}@${brk.index}`).join(', ');
    const attachmentBreaks = health.attachmentBreaks
      .map((brk) => `${brk.hash} ${brk.reason}`)
      .join(', ');
    return {
      ok: health.ok,
      lines: [
        title,
        `- chain: ${health.totalBreaks === 0 ? 'ok' : `BROKEN (${health.totalBreaks} breaks: ${breaks})`}, ${health.totalRecords} records, repaired lines: ${health.repairedLines.length}`,
        health.totalAttachmentBreaks === 0
          ? '- attachments: ok'
          : `- attachments: BROKEN (${health.totalAttachmentBreaks}: ${attachmentBreaks})`,
        ...timelineSection(records),
        ...keySection(batchesOf(records)),
        '',
      ],
    };
  } catch (error) {
    return { ok: false, lines: [title, `- ${formatCliError('insights', error).text}`, ''] };
  }
}

function listTargets(composed: Composed, filter: string | undefined) {
  const [projectFilter, processFilter] = filter?.split('/') ?? [];
  const { query } = composed.services;
  return (query.list({}).projects ?? [])
    .filter((project) => isNil(projectFilter) || project.name === projectFilter)
    .flatMap((project) =>
      (query.list({ project: project.name }).project?.processes ?? [])
        .filter(({ name }) => isNil(processFilter) || name === processFilter)
        .map(({ name }) => ({ project: project.name, process: name })),
    );
}

function main(filter: string | undefined): number {
  const dir = dataDir(process.env);
  const logger = () => undefined;
  const composed = compose({ dataDir: dir, cwd: process.cwd(), clock: () => new Date(), logger });
  if (composed.isLegacy()) {
    const { text, exitCode } = formatCliError('insights', legacyDataError());
    console.error(text);
    return exitCode;
  }

  let targets: ReturnType<typeof listTargets>;
  try {
    targets = listTargets(composed, filter);
  } catch (error) {
    console.error(formatCliError('insights', error).text);
    return 1;
  }

  if (isEmpty(targets)) {
    console.log(`No processes found in ${dir}${isNil(filter) ? '' : ` matching '${filter}'`}.`);
    return isNil(filter) ? 0 : 1;
  }

  const reports = targets.map((target) => processReport(composed, target.project, target.process));
  console.log(['# hexlog insights', '', ...reports.flatMap((report) => report.lines)].join('\n'));
  return reports.every((report) => report.ok) ? 0 : 1;
}

process.exitCode = main(process.argv[2]);
