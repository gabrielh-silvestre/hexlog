// Timeline read-only de targets, cruzando todos os processos de um projeto.
// Uso: node scripts/timeline.ts <project> <target>... [--full] [--json]
import { isNil } from 'es-toolkit';
import { dataDir } from '../src/directory.ts';
import type { HexlogError } from '../src/errors.ts';
import type { Timeline, TimelineEntry } from '../src/timeline.ts';
import { loadTimeline } from '../src/timeline-tools.ts';

const USAGE = 'usage: node scripts/timeline.ts <project> <target>... [--full] [--json]';
const FLAGS = ['--full', '--json'];

/** Cadeia ou anexo quebrado, ou processo que nem carregou: exit 2. */
function isBroken({ processes, entries, warnings }: Timeline): boolean {
  return (
    processes.some(({ chain }) => !chain.ok) ||
    entries.some(({ attachment }) => !isNil(attachment) && attachment.status !== 'ok') ||
    warnings.some(({ code }) => code === 'PROCESS_CORRUPTED')
  );
}

function renderEntry(entry: TimelineEntry): string {
  const { attachment } = entry;
  const superseded = isNil(entry.supersededBy)
    ? ''
    : `  [superado por ${entry.supersededBy.join(', ')}]`;
  const header = [entry.at, `${entry.process}#${entry.seq}`, entry.type, entry.agent]
    .concat(isNil(entry.source) ? [] : [`source=${entry.source}`])
    .concat(isNil(entry.result) ? [] : [`result=${entry.result}`]);
  const lines = [
    `${header.join('  ')}${superseded}`,
    `  id: ${entry.id}`,
    `  target: ${entry.target}`,
    `  summary: ${JSON.stringify(entry.summary)}`,
  ];
  if (!isNil(entry.supersedes)) lines.push(`  supersedes: ${entry.supersedes.join(', ')}`);
  if (!isNil(attachment)) lines.push(`  attachment: ${attachment.hash} (${attachment.status})`);
  // texto contíguo e idêntico entre os delimitadores: sem recuo, sem corte
  if (!isNil(attachment?.text)) {
    lines.push(
      `----- attachment ${attachment.hash} (${attachment.bytes} bytes) -----`,
      attachment.text,
      '----- end -----',
    );
  }
  return lines.join('\n');
}

function renderText({ processes, entries }: Timeline): string {
  const chains = processes.map(({ process, chain }) =>
    chain.ok
      ? `process ${process}: chain ok (${chain.totalLines} lines)`
      : `process ${process}: chain BROKEN (${chain.totalBreaks} breaks)`,
  );
  return `${[chains.join('\n'), ...entries.map(renderEntry)].join('\n\n')}\n`;
}

function renderJson({ processes, entries }: Timeline): string {
  const lines = [
    ...processes.map(({ process, chain }) => ({
      kind: 'chain',
      process,
      ok: chain.ok,
      totalLines: chain.totalLines,
      totalBreaks: chain.totalBreaks,
      breaks: chain.breaks,
    })),
    ...entries.map((entry) => ({ kind: 'entry', ...entry })),
  ];
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

function main(argv: string[]): number {
  const [project, ...targets] = argv.filter((arg) => !arg.startsWith('--'));
  const flags = argv.filter((arg) => arg.startsWith('--'));
  if (isNil(project) || targets.length === 0 || flags.some((flag) => !FLAGS.includes(flag))) {
    console.error(`timeline failed: ${USAGE}`);
    return 1;
  }

  try {
    const timeline = loadTimeline(dataDir(process.env), project, targets, {
      full: flags.includes('--full'),
    });
    process.stdout.write(flags.includes('--json') ? renderJson(timeline) : renderText(timeline));
    // avisos no stderr: o stdout do --json fica só com as linhas `chain` e `entry`
    for (const { code, message } of timeline.warnings) console.error(`warning ${code}: ${message}`);
    return isBroken(timeline) ? 2 : 0;
  } catch (error) {
    const { code, message } = error as HexlogError;
    console.error(`timeline failed: ${code ?? 'ERROR'}: ${message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
