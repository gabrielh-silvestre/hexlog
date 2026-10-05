import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Gate, RecordType, RelationName } from '../../domain/definitions.ts';
import { Hash, Name } from '../../domain/ids.ts';
import { defineTool, type ToolDeps, WRITE_ANNOTATIONS } from '../kernel.ts';

const Breaking = z
  .boolean()
  .optional()
  .describe(
    'Raises the major version. Required when a type or relation change breaks compatibility; optional ' +
      'for gates. Ignored on the first version and on a definition identical to the current one (a ' +
      'replay, `created: false`).',
  );

// D-17: sem array `warnings`; a divergência é o campo tipado `divergentVersions`.
const Defined = z.object({
  name: Name,
  version: z.string(),
  hash: Hash,
  created: z.boolean(),
  previousVersion: z.string().optional(),
  divergentVersions: z.array(z.string()).optional(),
});

const DefineType = z.strictObject({
  project: Name,
  name: Name,
  schema: RecordType,
  breaking: Breaking,
});

// A regra de conteúdo e o teto de 16.000 caracteres moram no domínio; aqui só se somam os campos da tool.
const DefineRelation = RelationName.safeExtend({ project: Name, breaking: Breaking });

const DefineGate = Gate.safeExtend({ project: Name, breaking: Breaking });

/** Registra `define_type`, `define_relation` e `define_gate`: versões imutáveis de definição do projeto. */
export function registerDefinitionTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    {
      name: 'define_type',
      schema: DefineType,
      title: 'Define type',
      description:
        'Defines a record type for the project as a JSON Schema (root `type: "object"`), saving a new ' +
        'immutable version. The same schema again is a replay (`created: false`). Adding an optional ' +
        'property or an enum value is a minor version; any other change needs `breaking: true`, ' +
        'otherwise it is refused with BREAKING_CHANGE. The schema is checked by a strict ajv; every ' +
        '`pattern` needs `maxLength` of at most 256 in the same subschema, and `patternProperties` needs ' +
        '`propertyNames.maxLength` of at most 256; a property with `format: ' +
        '"attachment"` holds the hash of an attachment, and the format is accepted only on a top-level ' +
        'property or on the items of a top-level array; at most 16000 canonical characters.',
      outputSchema: Defined,
      annotations: WRITE_ANNOTATIONS,
    },
    (input) => deps.services.definition.defineType(input),
  );

  defineTool(
    server,
    deps,
    {
      name: 'define_relation',
      schema: DefineRelation,
      title: 'Define relation',
      description:
        'Defines a relation name for the project: its `kind` and, optionally, the record types ' +
        'allowed on each end (`from`, `to`; omitted means any type). Widening `from`/`to` is a minor ' +
        'version; changing `kind` or narrowing the lists needs `breaking: true`. The same relation ' +
        'again is a replay (`created: false`).',
      outputSchema: Defined,
      annotations: WRITE_ANNOTATIONS,
    },
    (input) => deps.services.definition.defineRelation(input),
  );

  defineTool(
    server,
    deps,
    {
      name: 'define_gate',
      schema: DefineGate,
      title: 'Define gate',
      description:
        'Defines a gate for the project: a list of questions that `evaluate_gate` answers over the ' +
        'records, each with an optional `scope` ("process", the default, or "project"). A question ' +
        'passes when: `approved`, at least one current record matches `of` and each has a current ' +
        '`supports` source (matching `by`, if given) and no current `contradicts` source; `occurred`, ' +
        'at least `min` (default 1) current records match `select`; `no_pending`, every current record ' +
        'matching `pending` has a current source linked by the `resolvedBy` relation (of a `from` type, ' +
        'if given); `no_open_contradiction`, no current record matching `of` (default: all) has a ' +
        'current `contradicts` source. Every change is a minor version; send `breaking: true` when ' +
        'the change tightens the gate. The same gate again is a replay (`created: false`).',
      outputSchema: Defined,
      annotations: WRITE_ANNOTATIONS,
    },
    (input) => deps.services.definition.defineGate(input),
  );
}
