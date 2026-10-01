/**
 * Corta `text` em `[offset, offset + limit)` sem partir um par surrogate: se o corte cair depois
 * de um high surrogate, recua 1 (ou avança 1, se recuar deixaria a página vazia). Puro: usado pela
 * leitura paginada de anexos e pelo teto de texto por entrada da timeline.
 */
export function sliceChars(
  text: string,
  offset: number,
  limit: number,
): { text: string; nextOffset: number | null } {
  let end = Math.min(offset + limit, text.length);
  const code = text.charCodeAt(end - 1);
  if (end < text.length && code >= 0xd800 && code <= 0xdbff) {
    end = end - 1 > offset ? end - 1 : end + 1;
  }
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
}
