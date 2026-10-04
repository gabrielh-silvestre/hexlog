import type { BatchItem } from '../../src/domain/record.ts';

// Contrato de `argv` dos processos filhos de `lock-holder.ts` e `crash-writer.ts`: cada um recebe um
// único argumento JSON com o formato abaixo. Só tipos: o pai (`adapters/lock-helpers.ts`, os specs) e
// o filho importam o mesmo contrato, e o `import type` some na execução, então nenhum filho roda
// dentro do jest.

/** Argumento JSON de cada modo de `lock-holder.ts`, por nome de modo. */
export type LockHolderArgs = {
  /** Espera os `total` irmãos na barreira e faz `rounds` rodadas de adquirir, criar `ownerFile` com `wx`, apagar e soltar. */
  rounds: {
    lockDir: string;
    ownerFile: string;
    rounds: number;
    barrierDir: string;
    total: number;
  };
  /** Adquire, imprime `{ pid, token }` e fica vivo até ser morto ou até o pai fechar o stdin. */
  hold: { lockDir: string };
  /** Espera os `total` irmãos na barreira e faz `rounds` gravações de 1 elo pelo `ProcessStore` real. */
  write: {
    dataDir: string;
    project: string;
    process: string;
    rounds: number;
    barrierDir: string;
    total: number;
  };
  /** Grava 1 elo e, com o lock na mão, espera (bloqueado) até `goFile` existir. */
  'write-gated': { dataDir: string; project: string; process: string; goFile: string };
  /** Espera os `total` irmãos na barreira e faz um `register` pelo `compose` real com `input`. */
  register: {
    dataDir: string;
    project: string;
    process: string;
    barrierDir: string;
    total: number;
    input: { key?: string; records: BatchItem[] };
  };
};

/** Argumento JSON de `crash-writer.ts`; `run` rotula as `key` dos lotes que o filho grava. */
export type CrashWriterArgs = { dataDir: string; project: string; process: string; run: number };
