import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { kebabCase } from 'es-toolkit';
import type { Detail } from '../errors.ts';
import type { Validator } from '../ports.ts';

/** Formato `attachment` (D-16): sha256 em hexadecimal minúsculo, igual a `Hash` em `domain/ids.ts`. */
const ATTACHMENT_FORMAT = /^[0-9a-f]{64}$/;

const escapePointerSegment = (segment: string): string =>
  segment.replace(/~/g, '~0').replace(/\//g, '~1');

/** Propriedade que o ajv só cita em `params`: o `instancePath` do erro aponta para o objeto pai. */
function offendingProperty(error: ErrorObject): string | undefined {
  const params = error.params as Record<string, unknown>;
  const name = params.missingProperty ?? params.additionalProperty ?? params.unevaluatedProperty;
  return typeof name === 'string' ? name : undefined;
}

function toDetail(error: ErrorObject): Detail {
  const property = offendingProperty(error);
  return {
    path:
      property === undefined
        ? error.instancePath
        : `${error.instancePath}/${escapePointerSegment(property)}`,
    code: kebabCase(error.keyword),
    message: error.message ?? 'schema validation failed',
  };
}

/**
 * Validador JSON Schema (2020-12) com ajv estrito e `ajv-formats`, mais o formato `attachment`.
 * O `$id` de um schema não fica registrado no ajv: cada chamada compila e esquece, então duas
 * versões de um tipo com o mesmo `$id` não colidem.
 */
export function createValidator(): Validator {
  const ajv = new Ajv2020.default({ strict: true, allErrors: true, logger: false });
  addFormats.default(ajv);
  ajv.addFormat('attachment', ATTACHMENT_FORMAT);

  const compile = (schema: Record<string, unknown>) => {
    try {
      return ajv.compile(schema);
    } finally {
      ajv.removeSchema(schema);
    }
  };

  return {
    checkSchema(schema) {
      try {
        if (!ajv.validateSchema(schema)) return (ajv.errors ?? []).map(toDetail);
        compile(schema);
        return [];
      } catch (error) {
        // Modo estrito (palavra-chave ou formato desconhecido), `$ref` sem destino e `$schema` de
        // outro rascunho saem como exceção, sem ponto no schema: o erro aponta `/schema`. Os do
        // metaschema acima seguem relativos ao schema, então o serviço não prefixa `/schema` nestes.
        return [{ path: '/schema', code: 'invalid-schema', message: (error as Error).message }];
      }
    },
    validate(schema, data) {
      const validate = compile(schema);
      return validate(data) ? [] : (validate.errors ?? []).map(toDetail);
    },
  };
}
