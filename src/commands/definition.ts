import type { ZodType } from 'zod';
import { hashOfJcs } from '../domain/chain.ts';
import {
  bumpVersion,
  classifyRelationChange,
  classifyTypeChange,
  compareVersions,
  Gate,
  RecordType,
  RelationName,
} from '../domain/definitions.ts';
import type { Change } from '../domain/definitions.ts';
import type { Hash, Name } from '../domain/ids.ts';
import { HexlogError, issueDetails } from '../errors.ts';
import type { DefinitionKind, DefinitionOf, DefinitionStore, Validator } from '../ports.ts';

type Breaking = { breaking?: boolean };

type DefineTypeInput = { project: Name; name: Name; schema: RecordType } & Breaking;
export type DefineRelationInput = { project: Name } & RelationName & Breaking;
export type DefineGateInput = { project: Name } & Gate & Breaking;

/**
 * D-17: `created` é `false` no replay (a definição já era a vigente; nada gravado e sem
 * `previousVersion`). `divergentVersions` lista as versões que outro escritor gravou a partir da
 * mesma base durante a chamada.
 */
export type Defined = {
  name: Name;
  version: string;
  hash: Hash;
  created: boolean;
  previousVersion?: string;
  divergentVersions?: string[];
};

export type DefinitionService = {
  /** D-11: qualquer mudança que não seja só acrescentar propriedade ou valor de `enum` é quebra. */
  defineType(input: DefineTypeInput): Defined;
  /** D-11: alargar `from`/`to` é minor; trocar `kind` ou estreitar as listas é quebra. */
  defineRelation(input: DefineRelationInput): Defined;
  /** D-11: o servidor não detecta quebra em gate; só `breaking: true` sobe o major. */
  defineGate(input: DefineGateInput): Defined;
};

/** O que muda de um `kind` para outro no motor de versão. */
type Rule<K extends DefinitionKind> = {
  kind: K;
  /** `path` do `BREAKING_CHANGE`: o campo que a mudança quebrou. */
  breakingPath: string;
  /** Forma e tetos da definição, antes de qualquer leitura ou gravação; devolve a definição normalizada. */
  shape(candidate: unknown): DefinitionOf[K];
  classify(previous: DefinitionOf[K], next: DefinitionOf[K]): Change;
};

const FIRST_VERSION = '1.0';

// Mesmo teto de tentativas do 0.x (`writeVersionExclusive`): cada volta relê o estado, então só
// repete enquanto outro escritor ocupa a versão alvo.
const MAX_ATTEMPTS = 10;

function shapeOf<T>(schema: ZodType<T>): (candidate: unknown) => T {
  return (candidate) => {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    throw new HexlogError(
      'INVALID_INPUT',
      'definition does not match its shape',
      issueDetails(parsed.error.issues, ''),
    );
  };
}

function typeRule(validator: Validator): Rule<'types'> {
  return {
    kind: 'types',
    breakingPath: '/schema',
    shape(schema) {
      const parsed = RecordType.safeParse(schema);
      if (!parsed.success) {
        throw new HexlogError(
          'INVALID_SCHEMA',
          'schema is not a JSON object within the size ceiling',
          issueDetails(parsed.error.issues, '/schema'),
        );
      }
      // O validador já limita a 50 (não trunca de novo) e devolve o `path` relativo ao documento do
      // schema, `''` na raiz: aqui vira o ponteiro para o campo `schema` da entrada.
      const details = validator.checkSchema(parsed.data);
      if (details.length > 0) {
        throw new HexlogError(
          'INVALID_SCHEMA',
          'schema is not a valid JSON Schema',
          details.map((detail) => ({ ...detail, path: `/schema${detail.path}` })),
        );
      }
      // O `data` de um registro é sempre objeto: schema de outra raiz nunca aceitaria nenhum.
      if (parsed.data.type !== 'object') {
        const message = 'schema root must be "type": "object"';
        throw new HexlogError('INVALID_SCHEMA', message, [
          { path: '/schema/type', code: 'invalid-type', message },
        ]);
      }
      return parsed.data;
    },
    classify: classifyTypeChange,
  };
}

const relationRule: Rule<'relations'> = {
  kind: 'relations',
  breakingPath: '',
  shape: shapeOf(RelationName),
  classify: classifyRelationChange,
};

const gateRule: Rule<'gates'> = {
  kind: 'gates',
  breakingPath: '',
  shape: shapeOf(Gate),
  classify: () => 'compatible',
};

/**
 * Versão a gravar sobre `previous` (D-11); `breaking: true` sobe o major mesmo sem quebra. A única
 * exceção é a definição idêntica à vigente: `defineVersioned` a devolve como replay
 * (`created: false`) antes de chamar esta função.
 */
function targetVersion<K extends DefinitionKind>(
  rule: Rule<K>,
  previous: { version: string; definition: DefinitionOf[K] } | undefined,
  next: DefinitionOf[K],
  breaking: boolean,
): string {
  if (previous === undefined) return FIRST_VERSION;
  const broken = rule.classify(previous.definition, next) === 'breaking';
  if (broken && !breaking) {
    const message = 'change requires breaking: true';
    throw new HexlogError('BREAKING_CHANGE', message, [
      { path: rule.breakingPath, code: 'breaking-change', message },
    ]);
  }
  return bumpVersion(previous.version, broken || breaking ? 'major' : 'minor');
}

/**
 * Motor único de versão imutável dos três `define*`. Dono da forma e dos tetos: nada que o
 * adaptador recusaria (`invalid-definition`) chega a `store.write`. Cada volta relê o estado:
 * `write` devolve `false` quando outro escritor ocupou a versão alvo, e então a definição idêntica
 * vira replay e uma diferente é decidida de novo sobre a vigente (outra minor, ou `BREAKING_CHANGE`).
 */
function defineVersioned<K extends DefinitionKind>(
  store: DefinitionStore,
  rule: Rule<K>,
  project: Name,
  name: Name,
  candidate: unknown,
  breaking: boolean,
): Defined {
  const next = rule.shape(candidate);
  const hash = hashOfJcs(next);
  let firstBase: string | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const latest = store.versions(project, rule.kind, name).at(-1);
    if (attempt === 0) firstBase = latest;
    const previous =
      latest === undefined
        ? undefined
        : { version: latest, definition: store.read(project, rule.kind, name, latest) };
    if (previous !== undefined && hashOfJcs(previous.definition) === hash) {
      return { name, version: previous.version, hash, created: false };
    }

    const version = targetVersion(rule, previous, next, breaking);
    if (!store.write(project, rule.kind, name, version, next)) continue;

    const divergent = store
      .versions(project, rule.kind, name)
      .filter(
        (other) =>
          other !== version && (firstBase === undefined || compareVersions(other, firstBase) > 0),
      );
    return {
      name,
      version,
      hash,
      created: true,
      ...(latest !== undefined && { previousVersion: latest }),
      ...(divergent.length > 0 && { divergentVersions: divergent }),
    };
  }

  const message = 'exclusive write did not succeed';
  throw new HexlogError('INTERNAL', message, [
    { path: '', code: 'exclusive-write-exhausted', message },
  ]);
}

export function createDefinitionService(deps: {
  store: DefinitionStore;
  validator: Validator;
}): DefinitionService {
  const { store, validator } = deps;
  const types = typeRule(validator);

  return {
    defineType: ({ project, name, schema, breaking = false }) =>
      defineVersioned(store, types, project, name, schema, breaking),
    defineRelation: ({ project, breaking = false, ...relation }) =>
      defineVersioned(store, relationRule, project, relation.name, relation, breaking),
    defineGate: ({ project, breaking = false, ...gate }) =>
      defineVersioned(store, gateRule, project, gate.name, gate, breaking),
  };
}
