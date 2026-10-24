import type { BatchItem } from '../../src/domain/record.ts';
import type { askQuestion, runTurn, startSession } from '../../scripts/flow/critic-run.ts';
import type { Command, Tool } from '../../scripts/flow/critic-tools.ts';

// Contrato de `argv` dos processos filhos de `lock-holder.ts`, `crash-writer.ts`,
// `attachment-probe.ts` e `critic-driver.ts`: cada um recebe um
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

/** Argumento JSON de `attachment-probe.ts`: a chamada do `AttachmentStore` que o filho executa. */
export type AttachmentProbeArgs = { dataDir: string; cwd: string; project: string } & (
  { call: 'status'; hash: string } | { call: 'putPath'; path: string }
);

/**
 * Argumento JSON de `critic-driver.ts`: a função do runner do critic que o filho chama (o jest não
 * altera o `PATH` real do processo, então o runner precisa rodar num filho para achar o CLI falso).
 * O filho imprime o retorno em JSON.
 */
export type CriticDriverArgs =
  | {
      call: 'runTurn';
      command: Command;
      cwd: string;
      tool: Tool;
      timing: Parameters<typeof runTurn>[1]['timing'];
    }
  | { call: 'startSession'; options: Parameters<typeof startSession>[0] }
  | {
      call: 'askQuestion';
      mailbox: string;
      timing?: NonNullable<Parameters<typeof askQuestion>[1]>['timing'];
      /** pid para `starttime` do leitor de `/proc` injetado; pid fora do mapa não tem `starttime`. */
      startTimes?: Record<number, number>;
    }
  | { call: 'closeMailbox'; mailbox: string };
