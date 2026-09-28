// Processo filho pro teste de concorrência de `installArtifact` (B2(h), passo
// 10b): hook e servidor são buffers sintéticos e as duas checagens são stubs —
// só a troca atômica de `installArtifact` importa aqui. Uma barreira em
// arquivos garante que os processos irmãos cheguem juntos na instalação, em
// vez de torcer pra concorrência real de processo acontecer por sorte.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { installArtifact } from '../../src/installation.ts';

const [, , home, version, variant, processId, totalProcessesText] = process.argv;
if ([home, version, variant, processId, totalProcessesText].some((v) => v === undefined)) {
  throw new Error(
    'usage: concurrent-install.ts <home> <version> <variant> <processId> <totalProcesses>',
  );
}
const totalProcesses = Number(totalProcessesText);

// Busy-wait síncrono: qualquer `await`/`setTimeout` aqui dá alguns ms de
// vantagem sistemática a quem chega por último (o que já viu a barreira cheia
// não dorme, quem chegou primeiro ainda está no timeout) — isso serializa os
// processos em vez de fazê-los colidir na troca atômica, que é o que o teste
// de concorrência (B2(h)) precisa provocar de propósito.
const barrierDir = path.join(home, '.barrier');
fs.mkdirSync(barrierDir, { recursive: true });
fs.writeFileSync(path.join(barrierDir, processId), '');
while (fs.readdirSync(barrierDir).length < totalProcesses) {
  // spin
}

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
    verifyServer: () => Promise.resolve(10),
    log: () => {},
  });
  process.stdout.write(JSON.stringify({ ok: true, action: result.action }));
  process.exit(0);
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
  process.exit(1);
}
