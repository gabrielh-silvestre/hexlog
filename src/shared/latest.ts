import { isUndefined } from 'es-toolkit';
import type { Name } from '../domain/ids.ts';
import type { DefinitionKind, DefinitionReader } from '../ports.ts';

/**
 * Nomes do projeto com a versão vigente (a mais nova) e todas as versões em ordem crescente.
 * Pasta de nome sem nenhuma versão (falha no meio de `DefinitionStore.write`) não tem vigente: fica de fora.
 */
export function latestVersions(
  definitions: DefinitionReader,
  project: Name,
  kind: DefinitionKind,
): { name: Name; version: string; versions: string[] }[] {
  return definitions.names(project, kind).flatMap((name) => {
    const versions = definitions.versions(project, kind, name);
    const version = versions.at(-1);
    return isUndefined(version) ? [] : [{ name, version, versions }];
  });
}
