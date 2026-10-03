import { randomUUIDv7 } from 'node:crypto';
import { createAttachmentStore } from './adapters/fs/attachment-store.ts';
import { createDefinitionStore } from './adapters/fs/definition-store.ts';
import { detectLegacy } from './adapters/fs/data-format.ts';
import { createProcessStore } from './adapters/fs/process-store.ts';
import { createSearchIndex } from './adapters/search.ts';
import { createValidator } from './adapters/validator.ts';
import { createAttachmentService } from './commands/attachment.ts';
import { createDefinitionService } from './commands/definition.ts';
import { createProcessService } from './commands/process.ts';
import { createQueryService } from './queries/query-service.ts';
import { loadVerified } from './shared/loader.ts';
import type { Logger } from './shared/logger.ts';
import type { ProcessRef } from './ports.ts';

export type ComposeOptions = {
  /** `<D>`: a área de dados, que o `path` do `attach` nunca alcança (D-15). */
  dataDir: string;
  /** Raiz do `path` do `attach` (D-15): o `server.ts` e a prévia passam `process.cwd()`. */
  cwd: string;
  clock: () => Date;
  logger: Logger;
};

/**
 * Raiz de composição (D-25): o único lugar, fora de `adapters/`, que conhece os adaptadores de disco.
 * Liga os adaptadores reais aos serviços de escrita e de consulta; `server.ts`, os scripts e os
 * testes só recebem o que sai daqui.
 */
export function compose({ dataDir, cwd, clock, logger }: ComposeOptions) {
  const validator = createValidator();
  const definitions = createDefinitionStore({ dataDir });
  const attachments = createAttachmentStore({ dataDir, cwd });
  const processes = createProcessStore({ dataDir, log: logger });

  return {
    services: {
      definition: createDefinitionService({ store: definitions, validator }),
      attachment: createAttachmentService({ store: attachments }),
      process: createProcessService({
        store: processes,
        definitions,
        attachments,
        validator,
        clock,
        // Id opaco (D-01): usa o relógio real do Node, não o `clock` injetado.
        newUuid: randomUUIDv7,
        logger,
      }),
      query: createQueryService({
        store: processes,
        definitions,
        attachments,
        search: createSearchIndex(),
        clock,
        logger,
      }),
    },
    /** Processo lido e verificado pelo carregador único (SL2), para os scripts que precisam dos elos crus. */
    loadProcess: (ref: ProcessRef) => loadVerified(processes, ref),
    /** D-13: um `readdirSync` por chamada, para pegar dado 0.x que apareça com o servidor de pé. */
    isLegacy: (): boolean => detectLegacy(dataDir).length > 0,
  };
}
