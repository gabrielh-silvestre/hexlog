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
import type { Name } from './domain/ids.ts';
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

export type ComposeReaderOptions = Omit<ComposeOptions, 'clock'>;

/** Adaptadores de disco e o lado de leitura que `compose` e `composeReader` compartilham. */
function wire({ dataDir, cwd, logger }: ComposeReaderOptions) {
  const definitions = createDefinitionStore({ dataDir });
  const attachments = createAttachmentStore({ dataDir, cwd });
  const processes = createProcessStore({ dataDir, log: logger });

  const reader = {
    query: createQueryService({
      store: processes,
      definitions,
      attachments,
      search: createSearchIndex(),
    }),
    /** Processo lido e verificado pelo carregador único (SL2), para os scripts que precisam dos elos crus. */
    loadProcess: (ref: ProcessRef) => loadVerified(processes, ref),
    /** D-13: um `readdirSync` por chamada, para pegar dado 0.x que apareça com o servidor de pé. */
    isLegacy: (): boolean => detectLegacy(dataDir).length > 0,
    /** Enumeração sem ler o manifesto: um `process.json` ilegível não derruba a listagem. */
    list: (project: Name) => processes.list(project),
    listProjects: () => processes.listProjects(),
  };
  return { definitions, attachments, processes, reader };
}

/**
 * Raiz de composição (D-25): o único lugar, fora de `adapters/`, que conhece os adaptadores de disco.
 * Liga os adaptadores reais aos serviços de escrita e de consulta; `server.ts`, os scripts e os
 * testes só recebem o que sai daqui.
 */
export function compose(options: ComposeOptions) {
  const { clock, logger } = options;
  const { definitions, attachments, processes, reader } = wire(options);
  const validator = createValidator();

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
      query: reader.query,
    },
    isLegacy: reader.isLegacy,
  };
}

/**
 * Só o lado de leitura de `compose`, para os scripts de leitura: o tipo de retorno não tem serviço de
 * escrita, então "script de leitura não grava" é garantia de tipo.
 */
export function composeReader(options: ComposeReaderOptions) {
  return wire(options).reader;
}
