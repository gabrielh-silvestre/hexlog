// Relatório markdown read-only (integridade, gates, timeline) sobre os logs do hexlog.
// Uso: node scripts/insights.ts [projeto[/processo]]; diretório de dados via XDG_DATA_HOME.
import {
  countBy,
  head,
  isNil,
  isNotNil,
  last,
  orderBy,
  partition,
  take,
  windowed,
} from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { isValidLink, verifyChain } from '../src/chain.ts';
import { listProjects, loadProcess } from '../src/definitions.ts';
import { dataDir } from '../src/directory.ts';
import type { HexlogError } from '../src/errors.ts';
import type { EventLine } from '../src/events.ts';
import { readText } from '../src/log.ts';
import { effectiveNow, projectState } from '../src/state.ts';

const TOP_GAPS = 3;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function gatesSection(lines: EventLine[]): string[] {
  const gates = lines
    .filter((line) => line.type === 'milestone' && line.data.milestoneType === 'gate')
    .map((line) => line.data.gate as { name: string; passed: boolean });
  if (isEmpty(gates)) return ['- gates: none evaluated'];
  const [passed, failed] = partition(gates, (gate) => gate.passed);
  const perGate = countBy(gates, (gate) => `${gate.name} ${gate.passed ? 'pass' : 'fail'}`);
  return [
    `- gates: ${gates.length} evaluated, ${passed.length} pass, ${failed.length} fail`,
    ...Object.entries(perGate).map(([key, count]) => `  - ${key}: ${count}`),
  ];
}

function timelineSection(lines: EventLine[]): string[] {
  const first = head(lines);
  const final = last(lines);
  if (isNil(first) || isNil(final)) return ['- timeline: no events'];
  const pairs = windowed(lines, 2, 1).map(([from, to]) => ({
    ms: Date.parse(to.timestamp) - Date.parse(from.timestamp),
    from: from.seq,
    to: to.seq,
  }));
  const gaps = take(orderBy(pairs, [(gap) => gap.ms], ['desc']), TOP_GAPS);
  const perDay = countBy(lines, (line) => line.timestamp.slice(0, 10));
  const perMilestone = countBy(
    lines.filter((line) => line.type === 'milestone'),
    (line) => String(line.data.milestoneType),
  );
  return [
    `- first event: ${first.timestamp}`,
    `- last event: ${final.timestamp}`,
    `- total duration: ${formatDuration(Date.parse(final.timestamp) - Date.parse(first.timestamp))}`,
    '- events per day:',
    ...Object.entries(perDay).map(([day, count]) => `  - ${day}: ${count}`),
    '- milestones by type:',
    ...Object.entries(perMilestone).map(([type, count]) => `  - ${type}: ${count}`),
    `- largest gaps (top ${TOP_GAPS}):`,
    ...gaps.map((gap) => `  - ${formatDuration(gap.ms)} between seq ${gap.from} and ${gap.to}`),
  ];
}

function processReport(
  dir: string,
  project: string,
  processName: string,
): { lines: string[]; ok: boolean } {
  const title = `## ${project}/${processName}`;
  try {
    const loaded = loadProcess(dir, project, processName);
    const text = readText(loaded.eventsFile);
    const events = text.split('\n').slice(0, -1).map(isValidLink).filter(isNotNil);
    const chain = verifyChain(text, loaded.manifest);
    const projection = projectState(
      events,
      loaded.manifest.fixed.vocabulary,
      effectiveNow(new Date().toISOString(), events),
    );
    const breaks = chain.breaks.map((brk) => `${brk.reason}@${brk.index}`).join(', ');
    const forks = projection.forks
      .map((fork) => `${fork.verdict} -> ${fork.successors.join(', ')}`)
      .join('; ');
    return {
      ok: chain.ok,
      lines: [
        title,
        `- chain: ${chain.ok ? 'ok' : `BROKEN (${chain.totalBreaks} breaks: ${breaks})`}, ${chain.totalLines} lines, repaired lines: ${chain.repairedLines.length}`,
        isEmpty(forks) ? '- forks: none' : `- forks: ${forks}`,
        ...gatesSection(events),
        ...timelineSection(events),
        '',
      ],
    };
  } catch (error) {
    return { ok: false, lines: [title, `- load failed: ${(error as Error).message}`, ''] };
  }
}

function main(filter: string | undefined): number {
  const dir = dataDir(process.env);
  const [projectFilter, processFilter] = filter?.split('/') ?? [];
  let projects: ReturnType<typeof listProjects>;
  try {
    projects = listProjects(dir);
  } catch (error) {
    const { code, message } = error as HexlogError;
    console.error(`insights failed: ${code ?? 'ERROR'}: ${message}`);
    return 1;
  }
  const targets = projects
    .filter((project) => isNil(projectFilter) || project.name === projectFilter)
    .flatMap((project) =>
      project.processes
        .filter((name) => isNil(processFilter) || name === processFilter)
        .map((name) => ({ project: project.name, process: name })),
    );

  if (isEmpty(targets)) {
    console.log(`No processes found in ${dir}${isNil(filter) ? '' : ` matching '${filter}'`}.`);
    return isNil(filter) ? 0 : 1;
  }

  const reports = targets.map((target) => processReport(dir, target.project, target.process));
  console.log(['# hexlog insights', '', ...reports.flatMap((report) => report.lines)].join('\n'));
  return reports.every((report) => report.ok) ? 0 : 1;
}

process.exitCode = main(process.argv[2]);
