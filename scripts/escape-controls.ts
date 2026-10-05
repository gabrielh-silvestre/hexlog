// Escape de terminal do `timeline`: o texto sai do log de agentes e quem o lê é o dono, num terminal.
// C0 (menos LF e TAB), DEL e C1 (`\p{Cc}`) mais os controles bidi que invertem a ordem visual
// (ALM, LRM, RLM, LRE a RLO, LRI a PDI); ESC, CSI, OSC e U+009B/U+009D entram aqui.
const TERMINAL_CONTROLS = /(?![\t\n])[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

/** Troca cada controle por `\uXXXX` visível (minúsculo, como o `JSON.stringify`); o resto passa intacto. */
export function escapeControls(text: string): string {
  return text.replace(
    TERMINAL_CONTROLS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
