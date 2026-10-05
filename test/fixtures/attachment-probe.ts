// Processo filho do `AttachmentStore` real: `attachment-probe.ts <json>`, com o argumento JSON de
// `fixture-args.ts#AttachmentProbeArgs`.
// Roda uma chamada e imprime uma linha JSON: `{"result": ...}` ou `{"error": {code, details}}`. Existe
// porque um `open` sem `O_NONBLOCK` num FIFO trava a thread de quem chama: no jest isso congelaria o
// worker, e aqui o pai (`execFileSync` com `timeout`) mata o filho e o teste falha.
import { createAttachmentStore } from '../../src/adapters/fs/attachment-store.ts';
import { HexlogError } from '../../src/errors.ts';
import type { AttachmentProbeArgs } from './fixture-args.ts';

const [, , argsJson] = process.argv;
if (argsJson === undefined) throw new Error('usage: attachment-probe.ts <json>');
const args = JSON.parse(argsJson) as AttachmentProbeArgs;

const store = createAttachmentStore({ dataDir: args.dataDir, cwd: args.cwd });

try {
  const result =
    args.call === 'status'
      ? store.status(args.project, args.hash)
      : store.putPath(args.project, args.path);
  console.log(JSON.stringify({ result }));
} catch (error) {
  if (!(error instanceof HexlogError)) throw error;
  console.log(JSON.stringify({ error: { code: error.code, details: error.details } }));
}
