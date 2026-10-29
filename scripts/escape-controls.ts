// Escape de terminal do `timeline`: o texto sai do log de agentes e quem o lê é o dono, num terminal.
// C0 (menos LF e TAB), DEL e C1 (`\p{Cc}`) mais os controles bidi que invertem a ordem visual
// (ALM, LRM, RLM, LRE a RLO, LRI a PDI); ESC, CSI, OSC e U+009B/U+009D entram aqui. Entram também os
// separadores Unicode de linha (U+2028/U+2029, que um consumidor divide como quebra) e os tag
// characters (U+E0000 a U+E007F), invisíveis ao humano e legíveis a um modelo. BOM e ZWJ passam
// (emoji composto usa o ZWJ).
const TERMINAL_CONTROLS = /(?![\t\n])[\p{Cc}؜‎‏‪-‮⁦-⁩\u2028\u2029\u{E0000}-\u{E007F}]/gu;

/**
 * Troca cada controle por `\uXXXX` visível (minúsculo, como o `JSON.stringify`); o resto passa intacto.
 * Fora do plano básico sai um escape por unidade UTF-16 (par substituto), que o `JSON.parse` desfaz.
 */
export function escapeControls(text: string): string {
  return text.replace(TERMINAL_CONTROLS, (char) =>
    char
      .split('')
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  );
}
