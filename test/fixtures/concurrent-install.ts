// Processo filho pro teste de concorrência de `installArtifact` (B2(h), passo
// 10b): hook e servidor são buffers sintéticos e as duas checagens são stubs —
// só a troca atômica de `installArtifact` importa aqui. Uma barreira em
// arquivos garante que os processos irmãos cheguem juntos na instalação, em
// vez de torcer pra concorrência real de processo acontecer por sorte. São duas
// barreiras: uma na chegada e outra dentro de `verifyServer`, depois de
// `existedBefore` e antes do swap — sem a segunda, um processo atrasado lê
// `existedBefore` depois do swap do irmão e toma outro ramo.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { installArtifact } from '../../src/installation.ts';

const [, , home, version, variant, processId, totalProcessesText] = process.argv;
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
const spinBarrier = (name: string): void => {
  const barrierDir = path.join(home, name);
  fs.mkdirSync(barrierDir, { recursive: true });
  fs.writeFileSync(path.join(barrierDir, processId), '');
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (fs.readdirSync(barrierDir).length < totalProcesses) {
    if (Date.now() > deadline) {
      throw new Error(`barrier ${name} timed out`);
    }
  }
};

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
      return Promise.resolve(10);
    },
    log: () => undefined,
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
