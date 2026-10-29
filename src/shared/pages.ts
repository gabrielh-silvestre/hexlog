/** Code unit na faixa do high surrogate; `NaN` (índice fora do texto em `charCodeAt`) dá `false`. */
export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Corta `text` em `[offset, offset + limit)` sem partir um par surrogate: se o corte cair depois
 * de um high surrogate, recua 1 (ou avança 1, se recuar deixaria a página vazia). Puro: usado pela
 * leitura paginada de anexos (`queries/read-attachment.ts`).
 */
export function sliceChars(
  text: string,
  offset: number,
  limit: number,
): { text: string; nextOffset: number | null } {
  let end = Math.min(offset + limit, text.length);
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
    end = end - 1 > offset ? end - 1 : end + 1;
  }
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
}
