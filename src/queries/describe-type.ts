import { isUndefined } from 'es-toolkit';
import type { RecordType } from '../domain/definitions.ts';
import type { Name } from '../domain/ids.ts';
import { withoutFreePatterns } from '../domain/schema-walk.ts';
import { HexlogError, invalidInput } from '../errors.ts';
import type { DefinitionReader, ProcessReader } from '../ports.ts';
import { projectNotFound } from './read.ts';

export type DescribeTypeInput = {
  project: Name;
  type: Name;
  /** Devolve o tipo fixado no manifesto do processo; não vale junto de `version`. */
  process?: Name;
  /** Versão `<major>.<minor>` do projeto; sem ela e sem `process`, a vigente. */
  version?: string;
};

export type DescribeTypeResult = {
  name: Name;
  /** Ausente com `process`: o manifesto fixa o schema, não a versão. */
  version?: string;
  /** Sem `pattern` e `patternProperties`: o hexlog não os aplica, então não os mostra. */
  schema: RecordType;
};

function typeNotFound(): HexlogError {
  const message = 'type not found in the project';
  return new HexlogError('TYPE_NOT_FOUND', message, [
    { path: '/type', code: 'unknown-name', message },
  ]);
}

function typeNotPinned(type: Name): HexlogError {
  const message = `type '${type}' is not pinned in the process`;
  return new HexlogError('TYPE_NOT_PINNED', message, [
    { path: '/type', code: 'not-pinned', message },
  ]);
}

export function createDescribeType(deps: {
  store: ProcessReader;
  definitions: DefinitionReader;
}): (input: DescribeTypeInput) => DescribeTypeResult {
  const { store, definitions } = deps;

  return ({ project, type, process, version }) => {
    if (!isUndefined(process) && !isUndefined(version)) {
      throw invalidInput('/version', 'process-with-version', 'version is not allowed with process');
    }
    if (!isUndefined(process)) {
      const { types } = store.readManifest({ project, process }).fixed;
      if (!Object.hasOwn(types, type)) throw typeNotPinned(type);
      return { name: type, schema: withoutFreePatterns(types[type]!) };
    }
    const latest = definitions.versions(project, 'types', type).at(-1);
    // `read` aponta `/name` para o nome inexistente; aqui o campo da entrada é `/type`. O
    // `DefinitionReader` não separa tipo de projeto ausente: a lista de projetos só roda no erro.
    if (isUndefined(latest)) {
      throw store.listProjects().includes(project) ? typeNotFound() : projectNotFound();
    }
    const wanted = version ?? latest;
    return {
      name: type,
      version: wanted,
      schema: withoutFreePatterns(definitions.read(project, 'types', type, wanted)),
    };
  };
}
