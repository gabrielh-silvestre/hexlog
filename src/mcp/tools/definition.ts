import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Gate, RecordType, RelationName } from '../../domain/definitions.ts';
import { Hash, Name } from '../../domain/ids.ts';
import { advertise, execute } from '../kernel.ts';
import type { ToolDeps } from '../kernel.ts';

const Breaking = z
  .boolean()
  .optional()
  .describe('Required when the change breaks compatibility; raises the major version.');

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

const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Registra `define_type`, `define_relation` e `define_gate`: versões imutáveis de definição do projeto. */
export function registerDefinitionTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'define_type',
    {
      title: 'Define type',
      description:
        'Defines a record type for the project as a JSON Schema (root `type: "object"`), saving a new ' +
        'immutable version. The same schema again is a replay (`created: false`). Adding an optional ' +
        'property or an enum value is a minor version; any other change needs `breaking: true`, ' +
        'otherwise it is refused with BREAKING_CHANGE. A property with `format: "attachment"` holds ' +
        'the hash of an attachment.',
      inputSchema: advertise(DefineType),
      outputSchema: Defined,
      annotations: ANNOTATIONS,
    },
    (args, ctx) =>
      execute(deps, { name: 'define_type', schema: DefineType, args, ctx }, (input) =>
        deps.services.definition.defineType(input),
      ),
  );

  server.registerTool(
    'define_relation',
    {
      title: 'Define relation',
      description:
        'Defines a relation name for the project: its `kind` and, optionally, the record types ' +
        'allowed on each end (`from`, `to`; omitted means any type). Widening `from`/`to` is a minor ' +
        'version; changing `kind` or narrowing the lists needs `breaking: true`. The same relation ' +
        'again is a replay (`created: false`).',
      inputSchema: advertise(DefineRelation),
      outputSchema: Defined,
      annotations: ANNOTATIONS,
    },
    (args, ctx) =>
      execute(deps, { name: 'define_relation', schema: DefineRelation, args, ctx }, (input) =>
        deps.services.definition.defineRelation(input),
      ),
  );

  server.registerTool(
    'define_gate',
    {
      title: 'Define gate',
      description:
        'Defines a gate for the project: a list of questions (`approved`, `occurred`, `no_pending`, ' +
        '`no_open_contradiction`) that `evaluate_gate` answers over the records. Every change is a ' +
        'minor version; send `breaking: true` when the change tightens the gate. The same gate again ' +
        'is a replay (`created: false`).',
      inputSchema: advertise(DefineGate),
      outputSchema: Defined,
      annotations: ANNOTATIONS,
    },
    (args, ctx) =>
      execute(deps, { name: 'define_gate', schema: DefineGate, args, ctx }, (input) =>
        deps.services.definition.defineGate(input),
      ),
  );
}
