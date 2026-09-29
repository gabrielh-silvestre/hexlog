import { isNil, isNotNil, isString, omit, orderBy, pick } from 'es-toolkit';
import type { AttachmentStatus, Chain } from './chain.ts';
import { HexlogError } from './errors.ts';
import { matchesTargetPrefix, TargetPrefix, type EventLine } from './events.ts';
import { sliceChars } from './pages.ts';

const MAX_TARGETS = 20;
const MAX_WARNINGS = 100;
const MAX_BREAKS = 20;

/** Um processo já carregado e verificado pelo loader (`timeline-tools.ts`): a projeção não faz I/O. */
export type TimelineProcess = {
  name: string;
  lines: EventLine[];
  chain: Chain;
  attachmentStatus: ReadonlyMap<string, AttachmentStatus>;
  /**
   * Leitor do texto de um anexo íntegro, injetado pelo loader. Só é chamado com `full` e só para as
   * entradas da página devolvida (mais, no máximo, a que estoura o teto de caracteres da página).
   */
  readAttachmentText?: (hash: string) => string | undefined;
};

/** Processo cujo `process.json` não passou na verificação; vira um aviso, não derruba a timeline. */
export type UnloadableProcess = { name: string; error: string };

export type TimelineOptions = {
  full?: boolean;
  limit?: number;
  since?: number;
  /** Teto de caracteres de `attachment.text` por entrada; sem teto, o texto vai inteiro. */
  entryTextCap?: number;
  /** Teto de caracteres serializados por página; a primeira entrada entra mesmo acima dele. */
  pageCharsCap?: number;
};

export type TimelineAttachment = {
  hash: string;
  bytes?: number;
  status: AttachmentStatus;
  text?: string;
  truncated?: boolean;
  nextOffset?: number;
};

export type TimelineEntry = {
  at: string;
  process: string;
  seq: number;
  id: string;
  type: string;
  agent: string;
  source?: string;
  result?: string;
  target: string;
  summary: Record<string, unknown>;
  attachment?: TimelineAttachment;
  supersedes?: string[];
  supersededBy?: string[];
};

export type TimelineWarning = {
  code:
    | 'CHAIN_BROKEN'
    | 'ATTACHMENT_MISSING'
    | 'ATTACHMENT_CORRUPTED'
    | 'SUPERSEDES_DANGLING'
    | 'PROCESS_CORRUPTED';
  message: string;
  details?: unknown;
};

export type Timeline = {
  entries: TimelineEntry[];
  total: number;
  nextCursor: number | null;
  truncatedByCharCap?: boolean;
  processes: {
    process: string;
    chain: Pick<Chain, 'ok' | 'totalLines' | 'totalBreaks' | 'breaks'>;
  }[];
  warnings: TimelineWarning[];
  warningsTotal: number;
};

type Located = { line: EventLine; process: TimelineProcess };

/** Entrada sem o texto do anexo, com o elo de origem para buscá-lo só se a entrada entrar na página. */
type Item = { entry: TimelineEntry; located: Located };

function isNative(type: string): boolean {
  return type === 'milestone' || type === 'verdict';
}

function supersedesOf(line: EventLine): string[] | undefined {
  const { supersedes } = line.data;
  return Array.isArray(supersedes) && supersedes.every(isString) ? supersedes : undefined;
}

/** `INVALID_INPUT` se `targets` não tem 1 a 20 prefixos `hex:target:...` válidos. */
export function assertTargets(targets: readonly string[]): void {
  const invalid = targets.filter((target) => !TargetPrefix.safeParse(target).success);
  if (targets.length >= 1 && targets.length <= MAX_TARGETS && invalid.length === 0) return;
  throw new HexlogError(
    'INVALID_INPUT',
    `targets must be 1 to ${MAX_TARGETS} valid target prefixes`,
    [
      {
        path: '/targets',
        code: 'bad_args',
        message: `${targets.length} targets, ${invalid.length} invalid`,
      },
    ],
  );
}

/** O `data.target` do elo casa algum dos prefixos (fronteira de `.`). */
function matchesAnyTarget(line: EventLine, targets: readonly string[]): boolean {
  const { target } = line.data;
  return isString(target) && targets.some((prefix) => matchesTargetPrefix(target, prefix));
}

/**
 * `supersededBy` de cada id, sobre todos os elos do projeto. Um Verdict só supersede Verdict; um
 * evento custom só supersede evento custom (a supersessão de Verdict vem só do `supersedes` do
 * próprio Verdict). Id citado que não existe no projeto vem em `dangling`.
 */
function supersessions(ordered: Located[]): {
  supersededBy: Map<string, string[]>;
  dangling: Map<string, string[]>;
} {
  const typeById = new Map(ordered.map(({ line }) => [line.id, line.type]));
  const supersededBy = new Map<string, string[]>();
  const dangling = new Map<string, string[]>();

  for (const { line } of ordered) {
    for (const id of supersedesOf(line) ?? []) {
      const type = typeById.get(id);
      if (isNil(type)) {
        dangling.set(line.id, [...(dangling.get(line.id) ?? []), id]);
      } else if (line.type === 'verdict' ? type === 'verdict' : !isNative(type)) {
        supersededBy.set(id, [...(supersededBy.get(id) ?? []), line.id]);
      }
    }
  }
  return { supersededBy, dangling };
}

function summaryOf(line: EventLine): Record<string, unknown> {
  const { data } = line;
  if (line.type === 'verdict') return pick(data, ['claim', 'result', 'evidence']);
  if (line.type !== 'milestone')
    return omit(data, ['attachment', 'target', 'supersedes', 'source']);
  if (data.milestoneType !== 'gate') return pick(data, ['milestoneType', 'decisions']);
  const gate = data.gate as { name: string; passed: boolean };
  return { milestoneType: 'gate', gate: gate.name, passed: gate.passed };
}

function attachmentOf({ line, process }: Located): TimelineAttachment | undefined {
  const hash = line.data.attachment;
  const status = isString(hash) ? process.attachmentStatus.get(hash) : undefined;
  return isString(hash) && isNotNil(status) ? { hash, status } : undefined;
}

function buildItem(located: Located, supersededBy: Map<string, string[]>): Item {
  const { line, process } = located;
  const { source, result } = line.data;
  const supersedes = supersedesOf(line);
  const attachment = attachmentOf(located);
  const entry: TimelineEntry = {
    at: line.timestamp,
    process: process.name,
    seq: line.seq,
    id: line.id,
    type: line.type,
    agent: line.agent,
    ...(isString(source) ? { source } : {}),
    ...(isString(result) ? { result } : {}),
    target: line.data.target as string,
    summary: summaryOf(line),
    ...(isNil(attachment) ? {} : { attachment }),
    ...(isNil(supersedes) ? {} : { supersedes }),
    ...(supersededBy.has(line.id) ? { supersededBy: supersededBy.get(line.id) } : {}),
  };
  return { entry, located };
}

/** A entrada com o texto do anexo íntegro (lido agora, cortado em `entryTextCap` se informado). */
function withAttachmentText(
  { entry, located }: Item,
  entryTextCap: number | undefined,
): TimelineEntry {
  const { attachment } = entry;
  const text =
    attachment?.status === 'ok' ? located.process.readAttachmentText?.(attachment.hash) : undefined;
  if (isNil(attachment) || isNil(text)) return entry;

  const shown = isNil(entryTextCap)
    ? { text, nextOffset: null }
    : sliceChars(text, 0, entryTextCap);
  return {
    ...entry,
    attachment: {
      ...attachment,
      bytes: Buffer.byteLength(text, 'utf8'),
      text: shown.text,
      ...(shown.nextOffset === null ? {} : { truncated: true, nextOffset: shown.nextOffset }),
    },
  };
}

function processWarnings(input: (TimelineProcess | UnloadableProcess)[]): TimelineWarning[] {
  return input.flatMap((process): TimelineWarning[] => {
    if ('error' in process) {
      return [
        { code: 'PROCESS_CORRUPTED', message: `process '${process.name}': ${process.error}` },
      ];
    }
    return process.chain.ok
      ? []
      : [
          {
            code: 'CHAIN_BROKEN',
            message: `process '${process.name}' has ${process.chain.totalBreaks} chain break(s)`,
            details: { process: process.name, totalBreaks: process.chain.totalBreaks },
          },
        ];
  });
}

function entryWarnings(
  entries: TimelineEntry[],
  dangling: Map<string, string[]>,
): TimelineWarning[] {
  return entries.flatMap((entry): TimelineWarning[] => {
    const found: TimelineWarning[] = [];
    if (entry.attachment?.status === 'missing' || entry.attachment?.status === 'corrupted') {
      found.push({
        code: entry.attachment.status === 'missing' ? 'ATTACHMENT_MISSING' : 'ATTACHMENT_CORRUPTED',
        message: `event '${entry.id}' has an attachment that is ${entry.attachment.status}`,
        details: { id: entry.id, hash: entry.attachment.hash },
      });
    }
    if (dangling.has(entry.id)) {
      found.push({
        code: 'SUPERSEDES_DANGLING',
        message: `event '${entry.id}' supersedes ids that are not in the project`,
        details: { id: entry.id, missing: dangling.get(entry.id) },
      });
    }
    return found;
  });
}

/**
 * Página de `items` a partir de `since`, com `limit` entradas e o teto de caracteres serializados.
 * O texto dos anexos (`full`) é lido aqui, entrada a entrada, e não antes de paginar.
 */
function paginate(
  items: Item[],
  { full, limit, since = 0, entryTextCap, pageCharsCap }: TimelineOptions,
): Pick<Timeline, 'entries' | 'nextCursor' | 'truncatedByCharCap'> {
  const candidates = items.slice(since, isNil(limit) ? undefined : since + limit);
  const page: TimelineEntry[] = [];
  let chars = 0;
  let truncatedByCharCap = false;
  for (const item of candidates) {
    const entry = full ? withAttachmentText(item, entryTextCap) : item.entry;
    const size = JSON.stringify(entry).length;
    if (isNotNil(pageCharsCap) && page.length > 0 && chars + size > pageCharsCap) {
      truncatedByCharCap = true;
      break;
    }
    page.push(entry);
    chars += size;
  }
  const end = since + page.length;
  return {
    entries: page,
    nextCursor: end < items.length ? end : null,
    ...(truncatedByCharCap ? { truncatedByCharCap } : {}),
  };
}

/**
 * Timeline de `targets` (prefixos `hex:target:...`) cruzando todos os processos do projeto, em
 * ordem cronológica (desempate por processo e `seq`), com superados, estado da cadeia e dos
 * anexos. Pura: `input` já vem carregado e verificado.
 */
export function projectTimeline(
  input: (TimelineProcess | UnloadableProcess)[],
  targets: readonly string[],
  options: TimelineOptions = {},
): Timeline {
  assertTargets(targets);

  const loaded = input.filter((process): process is TimelineProcess => 'lines' in process);
  const ordered = orderBy(
    loaded.flatMap((process) => process.lines.map((line): Located => ({ line, process }))),
    [
      ({ line }) => Date.parse(line.timestamp),
      ({ process }) => process.name,
      ({ line }) => line.seq,
    ],
    ['asc', 'asc', 'asc'],
  );
  const { supersededBy, dangling } = supersessions(ordered);

  const items = ordered
    .filter(({ line }) => matchesAnyTarget(line, targets))
    .map((located) => buildItem(located, supersededBy));
  const warnings = [
    ...processWarnings(input),
    ...entryWarnings(
      items.map(({ entry }) => entry),
      dangling,
    ),
  ];

  return {
    ...paginate(items, options),
    total: items.length,
    processes: loaded.map(({ name, chain }) => ({
      process: name,
      chain: {
        ...pick(chain, ['ok', 'totalLines', 'totalBreaks']),
        breaks: chain.breaks.slice(0, MAX_BREAKS),
      },
    })),
    warnings: warnings.slice(0, MAX_WARNINGS),
    warningsTotal: warnings.length,
  };
}
