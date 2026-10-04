// Processo filho do lock por pid (P2, TF2, TF4) e do `register` concorrente (SE5), com cinco modos.
// Uso: `lock-holder.ts <modo> <json>`, com um único argumento JSON por modo (formato em
// `fixture-args.ts#LockHolderArgs`):
//  - `rounds`: espera os `total` irmãos na barreira e faz `rounds` rodadas de adquirir, criar
//    `ownerFile` com `wx`, apagar e soltar. Um `EEXIST` no `wx` prova dois donos ao mesmo tempo;
//    imprime `{ rounds, collisions }`.
//  - `hold`: adquire `lockDir`, imprime `{ pid, token }` e fica vivo até ser morto ou até o pai
//    fechar o stdin; serve para provar dono vivo (não roubado) e dono morto (roubado).
//  - `write`: espera os `total` irmãos na barreira e faz `rounds` gravações de 1 elo pelo
//    `ProcessStore` real, cada uma sob o lock do processo; repete a gravação que der `lock-lost` e
//    qualquer outro erro derruba o filho (status 1, stderr). Imprime `{ rounds, retries }`.
//  - `write-gated`: grava 1 elo pelo `ProcessStore`; com o lock na mão e o lote montado, imprime
//    `{ pid }` e espera (bloqueado, sem devolver ao laço de eventos) até `goFile` existir. O pai
//    pausa o filho nesse ponto com SIGSTOP (TF4) e depois o libera.
//  - `register`: espera os `total` irmãos na barreira e faz um `register` pelo `compose` real com
//    `input` (`{ key?, records }`). Imprime `{ ok: true, replayed }` ou, se o domínio recusar,
//    `{ ok: false, code }`; outro erro derruba o filho (status 1, stderr).
import fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLockManager } from '../../src/adapters/fs/lock.ts';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import { compose } from '../../src/compose.ts';
import { HexlogError } from '../../src/errors.ts';
import type { ProcessRef, RawProcess } from '../../src/ports.ts';
import { verifyProcess } from '../../src/shared/loader.ts';
import { chainLine } from './chain-line.ts';
import type { LockHolderArgs } from './fixture-args.ts';

const [, , mode, argsJson] = process.argv;
if (mode === undefined || argsJson === undefined) {
  throw new Error('usage: lock-holder.ts <rounds|hold|write|write-gated|register> <json>');
}

// IMPORTANT: o orçamento padrão do lock (15 s) e a barreira abaixo (10 s) usam relógio real. Com
// pouca CPU ou disco livre na máquina (carga local, runner de CI lento), os filhos podem estourar
// esses limites e o teste falhar de forma intermitente, sem bug no código.
const manager = createLockManager({ log: () => undefined });

const BARRIER_TIMEOUT_MS = 10_000;
const GO_TIMEOUT_MS = 60_000;

// Barreira em arquivos: os irmãos largam juntos, senão o custo de subir cada processo os serializaria.
async function waitForSiblings(barrierDir: string, total: number): Promise<void> {
  fs.mkdirSync(barrierDir, { recursive: true });
  fs.writeFileSync(path.join(barrierDir, String(process.pid)), '');
  const deadline = performance.now() + BARRIER_TIMEOUT_MS;
  while (fs.readdirSync(barrierDir).length < total) {
    if (performance.now() > deadline) throw new Error('barrier timed out');
    await sleep(1);
  }
}

async function runRounds({
  lockDir,
  ownerFile,
  rounds,
  barrierDir,
  total,
}: LockHolderArgs['rounds']) {
  await waitForSiblings(barrierDir, total);
  let collisions = 0;
  for (let round = 0; round < rounds; round += 1) {
    const lock = await manager.acquire(lockDir);
    try {
      let created = false;
      try {
        fs.writeFileSync(ownerFile, String(process.pid), { flag: 'wx' });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        collisions += 1;
      }
      // alarga a janela em que um segundo dono, se existisse, bateria no `wx`
      await sleep(1);
      if (created) fs.unlinkSync(ownerFile);
    } finally {
      await manager.release(lock);
    }
  }
  process.stdout.write(JSON.stringify({ rounds, collisions }));
}

async function hold({ lockDir }: LockHolderArgs['hold']): Promise<void> {
  const lock = await manager.acquire(lockDir);
  process.stdout.write(`${JSON.stringify({ pid: process.pid, token: lock.token })}\n`);
  process.stdin.resume();
}

/** Lote de 1 elo encadeado ao fim do log lido; `tag` identifica quem o gravou. */
const singleLinkLine = (raw: RawProcess, tag: string): string =>
  chainLine(raw.manifest.process, verifyProcess(raw).end, 1, {
    agent: 'lock-holder',
    text: () => tag,
  });

async function runWrites({
  dataDir,
  project,
  process: processName,
  rounds,
  barrierDir,
  total,
}: LockHolderArgs['write']) {
  const ref: ProcessRef = { project, process: processName };
  const store = createProcessStore({ dataDir, log: () => undefined });
  await waitForSiblings(barrierDir, total);
  let retries = 0;
  for (let round = 0; round < rounds; round += 1) {
    for (;;) {
      try {
        await store.write(ref, (raw) => ({
          line: singleLinkLine(raw, `${process.pid}-${round}`),
          result: undefined,
        }));
        break;
      } catch (error) {
        // `lock-lost` é a resposta retentável do D-12 e nada foi gravado antes do `confirm`;
        // qualquer outro erro é falha crua e derruba o filho.
        if (!(error instanceof HexlogError) || error.details[0]?.code !== 'lock-lost') throw error;
        retries += 1;
      }
    }
  }
  process.stdout.write(JSON.stringify({ rounds, retries }));
}

/** `decide` é síncrono: a espera bloqueia a thread, e o filho fica com o lock na mão até `goFile` existir. */
function blockUntilExists(goFile: string): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + GO_TIMEOUT_MS;
  while (!fs.existsSync(goFile)) {
    if (performance.now() > deadline) throw new Error('go file timed out');
    Atomics.wait(cell, 0, 0, 5);
  }
}

async function runGatedWrite({
  dataDir,
  project,
  process: processName,
  goFile,
}: LockHolderArgs['write-gated']) {
  const ref: ProcessRef = { project, process: processName };
  const store = createProcessStore({ dataDir, log: () => undefined });
  await store.write(ref, (raw) => {
    const line = singleLinkLine(raw, `gated-${process.pid}`);
    process.stdout.write(`${JSON.stringify({ pid: process.pid })}\n`);
    blockUntilExists(goFile);
    return { line, result: undefined };
  });
}

async function runRegister({
  dataDir,
  project,
  process: processName,
  barrierDir,
  total,
  input,
}: LockHolderArgs['register']) {
  const ref: ProcessRef = { project, process: processName };
  const { services } = compose({
    dataDir,
    cwd: dataDir,
    clock: () => new Date(),
    logger: () => undefined,
  });
  await waitForSiblings(barrierDir, total);
  try {
    const { replayed } = await services.process.register({
      ...ref,
      author: { agent: 'lock-holder', model: 'test', client: 'test' },
      ...input,
    });
    process.stdout.write(JSON.stringify({ ok: true, replayed }));
  } catch (error) {
    if (!(error instanceof HexlogError)) throw error;
    process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
  }
}

const args: unknown = JSON.parse(argsJson);
switch (mode) {
  case 'rounds':
    await runRounds(args as LockHolderArgs['rounds']);
    break;
  case 'hold':
    await hold(args as LockHolderArgs['hold']);
    break;
  case 'write':
    await runWrites(args as LockHolderArgs['write']);
    break;
  case 'write-gated':
    await runGatedWrite(args as LockHolderArgs['write-gated']);
    break;
  case 'register':
    await runRegister(args as LockHolderArgs['register']);
    break;
  default:
    throw new Error(`unknown mode: ${mode}`);
}
