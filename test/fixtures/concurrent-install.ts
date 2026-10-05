// Processo filho pro teste de concorrência de `installArtifact` (B2(h), passo
// 10b): hook e servidor são buffers sintéticos e as duas checagens são stubs —
// só a troca atômica de `installArtifact` importa aqui. Uma barreira em
// arquivos garante que os processos irmãos cheguem juntos na instalação, em
// vez de torcer pra concorrência real de processo acontecer por sorte. São duas
// barreiras: uma na chegada e outra dentro de `verifyServer`, depois de
// `existedBefore` e antes do swap — sem a segunda, um processo atrasado lê
// `existedBefore` depois do swap do irmão e toma outro ramo.
//
// Com o 6º argumento posicional `interleave`, o fixture deixa de torcer pela corrida: congela
// `Date.now` (dois instaladores no mesmo ms) e intercala os dois `renameSync` do
// backup de forma fixa — o processo 2 chega no rename depois de o 1 já ter movido
// `versionDir` pra `old` e termina antes de o 1 seguir. Se o nome do backup
// dependesse do relógio, o rollback do 2 devolveria o backup do 1 a `versionDir`.
// Import default: o patch de `fs.renameSync` precisa ser visto por `src/installation.ts`, que usa o mesmo import default.
import fs from 'node:fs';
import * as path from 'node:path';
import { installArtifact, TOOLS_COUNT } from '../../src/installation.ts';

const [, , home, version, variant, processId, totalProcessesText, mode] = process.argv;
if (
  home === undefined ||
  version === undefined ||
  variant === undefined ||
  processId === undefined ||
  totalProcessesText === undefined
) {
  throw new Error(
    'usage: concurrent-install.ts <home> <version> <variant> <processId> <totalProcesses>',
  );
}
const totalProcesses = Number(totalProcessesText);

const BARRIER_TIMEOUT_MS = 5_000;

// Busy-wait síncrono: qualquer `await`/`setTimeout` aqui dá alguns ms de
// vantagem sistemática a quem chega por último (o que já viu a barreira cheia
// não dorme, quem chegou primeiro ainda está no timeout) — isso serializa os
// processos em vez de fazê-los colidir na troca atômica, que é o que o teste
// de concorrência (B2(h)) precisa provocar de propósito. Com `BARRIER_TIMEOUT_MS`,
// uma barreira que nunca enche falha em vez de travar o teste.
// `performance.now` e não `Date.now`: o modo `interleave` congela o relógio.
const spinUntil = (name: string, isDone: () => boolean): void => {
  const deadline = performance.now() + BARRIER_TIMEOUT_MS;
  while (!isDone()) {
    if (performance.now() > deadline) {
      throw new Error(`barrier ${name} timed out`);
    }
  }
};

const spinBarrier = (name: string): void => {
  const barrierDir = path.join(home, name);
  fs.mkdirSync(barrierDir, { recursive: true });
  fs.writeFileSync(path.join(barrierDir, processId), '');
  spinUntil(name, () => fs.readdirSync(barrierDir).length >= totalProcesses);
};

const signal = (name: string): void => fs.writeFileSync(path.join(home, name), '');
const waitFor = (name: string): void => spinUntil(name, () => fs.existsSync(path.join(home, name)));

if (mode !== undefined && mode !== 'interleave') {
  throw new Error(`unknown mode: ${mode}`);
}

// Quantas vezes o hook casou com o rename do backup: se o nome do backup mudar de prefixo, o
// hook nunca casa e o teste passaria sem intercalar nada — então o fim do processo falha alto.
let hooked = 0;
if (mode === 'interleave') {
  Date.now = () => 0;
  const renameSync = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (!String(to).includes('.old-')) return renameSync(from, to);
    hooked += 1;
    if (processId === '2') {
      signal('.second-at-backup');
      waitFor('.first-backed-up');
      return renameSync(from, to);
    }
    waitFor('.second-at-backup');
    renameSync(from, to);
    signal('.first-backed-up');
    waitFor('.second-finished');
  };
}

spinBarrier('.barrier');

const bundles = {
  server: Buffer.from(`server-${variant}`),
  hook: Buffer.from(`hook-${variant}`),
};

try {
  const result = await installArtifact({
    home,
    version,
    bundles,
    commit: null,
    dirty: false,
    clock: () => new Date(),
    runHook: (_hookFile, stdin) => ({ status: stdin.includes('/probe') ? 2 : 0 }),
    verifyServer: () => {
      spinBarrier('.barrier2');
      return Promise.resolve(TOOLS_COUNT);
    },
  });
  process.stdout.write(JSON.stringify({ ok: true, action: result.action }));
  // process.exitCode em vez de process.exit(): mesmo código de saída, sem sair
  // antes do stdout ser flushado (regra n/no-process-exit).
  process.exitCode = 0;
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 1;
}
if (mode === 'interleave' && hooked === 0) {
  throw new Error('interleave hook never matched a backup rename (.old- prefix changed?)');
}
if (mode === 'interleave' && processId === '2') signal('.second-finished');
