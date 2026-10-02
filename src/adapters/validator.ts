import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { kebabCase, uniqBy } from 'es-toolkit';
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

/** Alinhado a `BATCH_MAX` (`docs/tetos-dominio-v1.md`); sem medição por trás. */
const MAX_DETAILS = 50;

/**
 * O ajv repete o mesmo erro (o metaschema é revisitado por `$dynamicRef`), então deduplica por
 * path+code+message e corta em `MAX_DETAILS`, avisando no último `Detail` quantos ficaram de fora.
 */
function toDetails(errors: ErrorObject[]): Detail[] {
  const unique = uniqBy(errors.map(toDetail), (d) => `${d.path}\0${d.code}\0${d.message}`);
  if (unique.length <= MAX_DETAILS) return unique;
  return [
    ...unique.slice(0, MAX_DETAILS),
    {
      path: '',
      code: 'too-many-errors',
      message: `${unique.length - MAX_DETAILS} more errors omitted`,
    },
  ];
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
    // O `removeSchema` do `finally` apaga por `$id`: com um `$id` que o ajv já conhece (os
    // metaschemas) ele levaria o schema alheio junto.
    const id = schema.$id;
    if (typeof id === 'string' && ajv.getSchema(id)) {
      throw new Error(`schema with $id "${id}" is already registered`);
    }
    try {
      const validate = ajv.compile(schema);
      // `$async` só existe no tipo da função assíncrona; o ajv a devolve com `$async: true`.
      if ((validate as { $async?: boolean }).$async)
        throw new Error('async schemas ($async: true) are not supported');
      return validate;
    } finally {
      ajv.removeSchema(schema);
    }
  };

  return {
    checkSchema(schema) {
      try {
        if (!ajv.validateSchema(schema)) return toDetails(ajv.errors ?? []);
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
      return validate(data) ? [] : toDetails(validate.errors ?? []);
    },
  };
}
