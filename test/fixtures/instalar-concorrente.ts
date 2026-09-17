// Processo filho pro teste de concorrência de `instalarArtefato` (B2(h), passo
// 10b): hook e servidor são buffers sintéticos e as duas checagens são stubs —
// só a troca atômica de `instalarArtefato` importa aqui. Uma barreira em
// arquivos garante que os processos irmãos cheguem juntos na instalação, em
// vez de torcer pra concorrência real de processo acontecer por sorte.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { instalarArtefato } from '../../src/instalacao.ts';

const [, , home, versao, variante, idProcesso, totalProcessosTexto] = process.argv;
if ([home, versao, variante, idProcesso, totalProcessosTexto].some((v) => v === undefined)) {
  throw new Error(
    'uso: instalar-concorrente.ts <home> <versao> <variante> <idProcesso> <totalProcessos>',
  );
}
const totalProcessos = Number(totalProcessosTexto);

// Busy-wait síncrono: qualquer `await`/`setTimeout` aqui dá alguns ms de
// vantagem sistemática a quem chega por último (o que já viu a barreira cheia
// não dorme, quem chegou primeiro ainda está no timeout) — isso serializa os
// processos em vez de fazê-los colidir na troca atômica, que é o que o teste
// de concorrência (B2(h)) precisa provocar de propósito.
const dirBarreira = path.join(home, '.barreira');
fs.mkdirSync(dirBarreira, { recursive: true });
fs.writeFileSync(path.join(dirBarreira, idProcesso), '');
while (fs.readdirSync(dirBarreira).length < totalProcessos) {
  // spin
}

const bundles = {
  servidor: Buffer.from(`servidor-${variante}`),
  hook: Buffer.from(`hook-${variante}`),
};

try {
  const resultado = await instalarArtefato({
    home,
    versao,
    bundles,
    commit: null,
    sujo: false,
    agora: () => new Date(),
    executarHook: (_arquivoHook, stdin) => ({ status: stdin.includes('/sonda') ? 2 : 0 }),
    verificarServidor: async () => 10,
    log: () => {},
  });
  process.stdout.write(JSON.stringify({ ok: true, acao: resultado.acao }));
  process.exit(0);
} catch (erro) {
  process.stdout.write(
    JSON.stringify({ ok: false, mensagem: erro instanceof Error ? erro.message : String(erro) }),
  );
  process.exit(1);
}
