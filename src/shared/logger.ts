/** Registro de log de uma linha: `level` e `event` fixos, o resto é contexto livre do evento. */
export type LogRecord = {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  [field: string]: unknown;
};

/** D-22: o único tipo de logger da árvore nova; quem compõe decide para onde a linha vai. */
export type Logger = (record: LogRecord) => void;
