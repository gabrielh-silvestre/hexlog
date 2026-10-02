import type { Name } from '../domain/ids.ts';
import { HexlogError } from '../errors.ts';
import type { AttachmentPut, AttachmentStore } from '../ports.ts';

export type AttachInput = { project: Name; text?: string; path?: string };

export type AttachmentService = {
  /**
   * D-15: exatamente um de `text`/`path`. Toda recusa deste serviço é regra pura sobre a entrada e
   * sai antes de a porta ser chamada; a ordem é fixa e só a primeira recusa sai: `bad-args` (nenhum
   * ou os dois), depois, no `path`, NUL e segmento acima de 255 bytes (`bad-args`), depois
   * `bad-extension`; no `text`, vazio e surrogate solto.
   */
  attach(input: AttachInput): AttachmentPut;
};

const ALLOWED_EXTENSIONS = ['.md', '.txt'];

// NAME_MAX do Linux, em bytes UTF-8: acima disso o `open` falha com ENAMETOOLONG, que viraria IO_ERROR.
const NAME_MAX_BYTES = 255;

// Surrogate alto sem baixo depois, ou baixo sem alto antes (sem a flag `u`, a string é lida por unidade).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function invalidInput(pointer: string, code: string, message: string): HexlogError {
  return new HexlogError('INVALID_INPUT', message, [{ path: pointer, code, message }]);
}

/**
 * Mesma regra de `path.extname` sobre o último componente (barras finais não contam): `.md` puro
 * não tem extensão, `x.MD` não casa. Não usa `node:path` porque `commands/` não importa builtin.
 */
function hasAllowedExtension(candidate: string): boolean {
  const name = candidate.replace(/\/+$/, '').split('/').pop() ?? '';
  return ALLOWED_EXTENSIONS.some(
    (extension) => name.length > extension.length && name.endsWith(extension),
  );
}

function checkedText(text: string): void {
  if (text.length === 0) throw invalidInput('/text', 'bad-args', 'text must not be empty');
  if (LONE_SURROGATE.test(text)) {
    throw invalidInput('/text', 'lone-surrogate', 'text contains a lone surrogate');
  }
}

function checkedPath(candidate: string): void {
  if (candidate.includes('\0')) throw invalidInput('/path', 'bad-args', 'path contains NUL');
  if (candidate.split('/').some((segment) => Buffer.byteLength(segment, 'utf8') > NAME_MAX_BYTES)) {
    throw invalidInput('/path', 'bad-args', `path segment exceeds ${NAME_MAX_BYTES} bytes`);
  }
  if (!hasAllowedExtension(candidate)) {
    throw invalidInput('/path', 'bad-extension', 'path must end in .md or .txt');
  }
}

export function createAttachmentService(deps: { store: AttachmentStore }): AttachmentService {
  const { store } = deps;

  return {
    attach({ project, text, path }) {
      if (path !== undefined && text === undefined) {
        checkedPath(path);
        return store.putPath(project, path);
      }
      if (text !== undefined && path === undefined) {
        checkedText(text);
        return store.putText(project, text);
      }
      throw invalidInput('', 'bad-args', 'exactly one of text or path is required');
    },
  };
}
