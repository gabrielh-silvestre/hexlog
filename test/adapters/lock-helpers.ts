import { expect } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import * as path from 'node:path';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import type { ProcessRef } from '../../src/ports.ts';
import { emptyManifest } from '../fixtures/chain-line.ts';
import { createTempDir } from '../helpers.ts';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'lock-holder.ts');

const children: ChildProcess[] = [];

/** Mata os filhos criados pelos helpers; cada spec chama no `afterEach`. */
export function killChildren(): void {
  for (const child of children.splice(0)) child.kill('SIGKILL');
}

export function runFixture(
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, ...args]);
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Filho real da fixture no `mode` dado; devolve quando ele imprime a primeira linha (`{ pid }`). */
export function startChild(args: string[]): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(process.execPath, [FIXTURE, ...args]);
  children.push(child);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('\n'))
        resolve({ child, pid: (JSON.parse(stdout) as { pid: number }).pid });
    });
    child.on('error', reject);
    child.on('exit', (status) =>
      reject(new Error(`child exited early with ${String(status)}: ${stderr}`)),
    );
  });
}

/** Filho real que adquire o lock e fica vivo; devolve quando ele já é o dono. */
export const startHolder = (lockDir: string) => startChild(['hold', lockDir]);

/** Processo vazio criado pelo `ProcessStore`, com o lock onde o store o usa (ao lado do log). */
export function createProcess() {
  const dataDir = createTempDir('lock-process');
  const ref: ProcessRef = { project: 'demo', process: 'proc-1' };
  const store = createProcessStore({ dataDir, log: () => undefined });
  store.create(ref, emptyManifest(ref));
  const { dir, lock } = processPaths(dataDir, ref);
  return { dataDir, store, ref, dir, lockDir: lock };
}

/** 8 filhos x 25 gravações no mesmo processo, com o lock de um dono morto pré-plantado. */
export async function runWriteStress() {
  const created = createProcess();
  const { dataDir, ref, lockDir } = created;
  const dead = await startHolder(lockDir);
  dead.child.kill('SIGKILL');
  await once(dead.child, 'exit');
  expect(fs.existsSync(lockDir)).toBe(true);
  const barrier = createTempDir('lock-barrier');
  const args = ['write', dataDir, ref.project, ref.process, '25', barrier, '8'];

  const results = await Promise.all(Array.from({ length: 8 }, () => runFixture(args)));

  return { ...created, results };
}
