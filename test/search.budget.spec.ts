import { describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { median } from 'es-toolkit';
import { search } from '../src/search.ts';
import type { ProcessManifest } from '../src/definitions.ts';
import { writeCorpus, generateCorpus } from './fixtures/corpus.ts';
import { type Environment, createEnvironment, registerCore } from './helpers.ts';

const PROJ = 'budget';
const PROC = 'proc1';
const SIZE = 10_000;

/** Fixa vocabulário núcleo + um tipo custom e cria o processo; devolve o manifesto real gravado. */
async function prepareProcess(environment: Environment): Promise<ProcessManifest> {
  await registerCore(environment, PROJ);
  await environment.call('register_type', {
    project: PROJ,
    name: 'note',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  });
  await environment.call('create_process', { project: PROJ, process: PROC });
  const content = fs.readFileSync(path.join(environment.dir, PROJ, PROC, 'process.json'), 'utf8');
  return JSON.parse(content) as ProcessManifest;
}

describe('M13', () => {
  test('orçamento: índice (construção + consulta) ≤ 500 ms e events{search} completo ≤ 2000 ms (medianas de 5, corpus de 10 000)', async () => {
    const environment = await createEnvironment();
    try {
      const manifest = await prepareProcess(environment);
      const corpus = generateCorpus({
        size: SIZE,
        manifest,
        vocabulary: manifest.fixed.vocabulary,
      });
      writeCorpus(path.join(environment.dir, PROJ, PROC, 'events.jsonl'), corpus.text);

      const candidates = corpus.lines.map((line, index) => ({ index, line }));
      const indexTimes = Array.from({ length: 5 }, () => {
        const start = performance.now();
        search(candidates, 'webhook');
        return performance.now() - start;
      });

      const callTimes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        const result = await environment.call('events', {
          project: PROJ,
          process: PROC,
          search: 'webhook',
          limit: 50,
        });
        callTimes.push(performance.now() - start);
        expect(result.isError).not.toBe(true);
      }

      const indexMedian = median(indexTimes);
      const callMedian = median(callTimes);
      process.stdout.write(`M13 median index (build+query): ${indexMedian.toFixed(2)} ms\n`);
      process.stdout.write(`M13 median full call events{search}: ${callMedian.toFixed(2)} ms\n`);

      expect(indexMedian).toBeLessThanOrEqual(500);
      expect(callMedian).toBeLessThanOrEqual(2000);
    } finally {
      await environment.close();
    }
  }, 60_000);
});
