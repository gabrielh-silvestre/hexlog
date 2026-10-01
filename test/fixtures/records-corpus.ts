import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataRoot } from '../../src/adapters/fs/data-format.ts';
import { anchor, hashLink, sha256hex, type Expected, type Link } from '../../src/domain/chain.ts';
import type { Manifest, ProcessRef } from '../../src/ports.ts';
import { formatLine } from '../../src/shared/loader.ts';

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const FIRST_MS = Date.parse(CREATED_AT);
/** Texto de cada registro; com os demais campos da linha dá ~1,2 KB. */
const TEXT_CHARS = 850;

const TYPES = ['note', 'milestone', 'verdict', 'decision'];
const TARGET_AREAS = ['account', 'order', 'payment', 'session', 'login'];
const WORDS = [
  'webhook',
  'authentication',
  'payment',
  'refund',
  'cache',
  'invalidation',
  'review',
  'process',
  'partner',
  'client',
  'configuration',
  'adjustment',
  'documentation',
  'milestone',
  'verdict',
  'pending',
  'items',
  'recorded',
  'agent',
  'step',
  'retry',
  'timeout',
  'session',
  'order',
  'account',
  'migration',
  'schema',
  'release',
  'deployment',
  'queue',
  'consumer',
  'handler',
  'latency',
  'throughput',
  'index',
  'report',
];

const hex = (value: number, width: number): string => value.toString(16).padStart(width, '0');

/** Texto indexável e determinístico: palavras do banco em ordem pseudoaleatória fixa por posição. */
function textFor(processIndex: number, seq: number): string {
  const words: string[] = [];
  let length = 0;
  for (let step = 0; length < TEXT_CHARS; step += 1) {
    const word = WORDS[(seq * 7 + step * 13 + processIndex * 5) % WORDS.length]!;
    words.push(word);
    length += word.length + 1;
  }
  return words.join(' ').slice(0, TEXT_CHARS);
}

function recordId(processName: string, processIndex: number, seq: number): string {
  return `${processName}:0198f4a0-${hex(processIndex, 4)}-7000-8000-${hex(seq, 12)}`;
}

const manifestOf = (ref: ProcessRef): Manifest => ({
  project: ref.project,
  process: ref.process,
  createdAt: CREATED_AT,
  fixed: { types: {}, relations: {}, gates: {} },
  hashes: { types: sha256hex(''), relations: sha256hex(''), gates: sha256hex('') },
});

/** Elo `seq` do processo; a cada 5 registros um `supports` para o anterior. */
function linkOf(ref: ProcessRef, processIndex: number, expected: Expected, batch?: Link['batch']) {
  const { seq } = expected;
  const type = TYPES[seq % TYPES.length]!;
  const area = TARGET_AREAS[seq % TARGET_AREAS.length]!;
  const link: Link = {
    seq,
    id: recordId(ref.process, processIndex, seq),
    type,
    at: new Date(FIRST_MS + seq * 1000).toISOString(),
    target: `${area}-${seq % 11}.${type}`,
    author: { agent: `corpus-agent-${seq % 3}`, client: 'test' },
    data: {
      text: textFor(processIndex, seq),
      ...(type === 'verdict' ? { result: seq % 2 === 0 ? 'pass' : 'fail' } : {}),
    },
    relations:
      seq > 0 && seq % 5 === 0
        ? [{ kind: 'supports', to: recordId(ref.process, processIndex, seq - 1) }]
        : [],
    prevHash: expected.prevHash,
    ...(batch === undefined ? {} : { batch }),
  };
  return link;
}

/** Processo encadeado de `count` elos em linhas de 1 a 3 elos (as de 2 ou mais levam `batch.key`). */
function buildProcess(ref: ProcessRef, processIndex: number, count: number) {
  const records: Link[] = [];
  const lines: string[] = [];
  let expected: Expected = { seq: 0, prevHash: anchor(manifestOf(ref)) };
  for (let lineNumber = 0; records.length < count; lineNumber += 1) {
    const size = Math.min(1 + (lineNumber % 3), count - records.length);
    const links: Link[] = [];
    for (let item = 0; item < size; item += 1) {
      const key = `batch-${lineNumber}`;
      const batch = item === 0 && size > 1 ? { fingerprint: sha256hex(key), key } : undefined;
      const link = linkOf(ref, processIndex, expected, batch);
      links.push(link);
      expected = { seq: link.seq + 1, prevHash: hashLink(link) };
    }
    records.push(...links);
    lines.push(formatLine(links));
  }
  return { records, text: lines.join('') };
}

export type RecordsCorpusOptions = {
  project?: string;
  processes?: string[];
  recordsPerProcess: number;
};

export type RecordsCorpus = {
  refs: ProcessRef[];
  /** Os elos gravados, processo a processo, na ordem do log: dá para medir sem ler o disco. */
  records: Link[];
};

/**
 * Corpus 1.0 determinístico (sem relógio nem aleatoriedade): grava direto em `<dataDir>/.v1/` o
 * `process.json` e o `records.jsonl` de cada processo, com a cadeia montada por `hashLink` e as
 * linhas por `formatLine`, sem passar pelo `ProcessStore`.
 */
export function writeRecordsCorpus(dataDir: string, options: RecordsCorpusOptions): RecordsCorpus {
  const { project = 'budget', processes = ['proc1'], recordsPerProcess } = options;
  const refs = processes.map((name) => ({ project, process: name }));
  const records = refs.flatMap((ref, processIndex) => {
    const built = buildProcess(ref, processIndex, recordsPerProcess);
    const dir = path.join(dataRoot(dataDir), ref.project, ref.process);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'process.json'), JSON.stringify(manifestOf(ref)));
    fs.writeFileSync(path.join(dir, 'records.jsonl'), built.text);
    return built.records;
  });
  return { refs, records };
}
