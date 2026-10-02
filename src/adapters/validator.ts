import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isPlainObject, kebabCase, uniqBy } from 'es-toolkit';
import safeRegex from 'safe-regex2';
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
 * Deduplica por path+code+message (o ajv repete o mesmo erro, pois o metaschema é revisitado por
 * `$dynamicRef`) e corta em `MAX_DETAILS`, avisando no último `Detail` quantos ficaram de fora.
 */
function capDetails(details: Detail[]): Detail[] {
  const unique = uniqBy(details, (d) => `${d.path}\0${d.code}\0${d.message}`);
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

const toDetails = (errors: ErrorObject[]): Detail[] => capDetails(errors.map(toDetail));

/** Teto de `maxLength` exigido junto a um `pattern`: limita o texto que a regex pode consumir. */
export const PATTERN_MAX_LENGTH = 256;

const SUBSCHEMA_KEYWORDS = [
  'additionalProperties',
  'items',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const SUBSCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SUBSCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies', // legada, mas o ajv 2020 estrito a aceita e aplica
];

/**
 * Percorre só as palavras-chave que carregam subschemas (nunca `const`/`enum`/`default`, que são
 * dado) e aponta cada `pattern` e cada chave de `patternProperties` que a `safe-regex2` recusa, e
 * cada `pattern` cujo subschema não tem `maxLength` inteiro até `PATTERN_MAX_LENGTH`.
 */
function patternDetails(root: unknown): Detail[] {
  const details: Detail[] = [];
  const reject = (path: string, message: string) =>
    details.push({ path, code: 'invalid-schema', message });

  const visit = (node: unknown, pointer: string): void => {
    if (!isPlainObject(node)) return;

    if (typeof node.pattern === 'string') {
      const path = `${pointer}/pattern`;
      if (!safeRegex(node.pattern))
        reject(path, 'pattern is unsafe (possible catastrophic backtracking)');
      if (typeof node.maxLength !== 'number' || node.maxLength > PATTERN_MAX_LENGTH)
        reject(
          path,
          `pattern requires a maxLength of at most ${PATTERN_MAX_LENGTH} in the same subschema`,
        );
    }
    if (isPlainObject(node.patternProperties)) {
      for (const key of Object.keys(node.patternProperties)) {
        if (!safeRegex(key))
          reject(
            `${pointer}/patternProperties/${escapePointerSegment(key)}`,
            'patternProperties key is unsafe (possible catastrophic backtracking)',
          );
      }
    }

    for (const key of SUBSCHEMA_KEYWORDS) visit(node[key], `${pointer}/${key}`);
    for (const key of SUBSCHEMA_LIST_KEYWORDS) {
      const list: unknown = node[key];
      if (Array.isArray(list)) list.forEach((item, i) => visit(item, `${pointer}/${key}/${i}`));
    }
    for (const key of SUBSCHEMA_MAP_KEYWORDS) {
      const map: unknown = node[key];
      if (!isPlainObject(map)) continue;
      for (const [name, child] of Object.entries(map))
        visit(child, `${pointer}/${key}/${escapePointerSegment(name)}`);
    }
  };

  visit(root, '');
  return capDetails(details);
}

/** Mesmas opções estritas e mesmos formatos nas duas instâncias; só `allErrors` muda. */
function createCompiler(allErrors: boolean) {
  const ajv = new Ajv2020.default({ strict: true, allErrors, logger: false });
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

  return { ajv, compile };
}

/**
 * Validador JSON Schema (2020-12) com ajv estrito e `ajv-formats`, mais o formato `attachment`.
 * O `$id` de um schema não fica registrado no ajv: cada chamada compila e esquece, então duas
 * versões de um tipo com o mesmo `$id` não colidem.
 *
 * Duas instâncias do ajv, com a mesma compilação: `checkSchema` usa `allErrors: true` e devolve
 * todos os erros do schema; `validate` usa `allErrors: false` e devolve um erro por subschema
 * avaliado, não um por campo (em `anyOf`/`oneOf`/`propertyNames` saem os dos ramos).
 *
 * O `path` de `checkSchema` é sempre relativo ao documento do schema (raiz = `''`), inclusive nos
 * erros de compilação, que saem com `path` vazio; quem expõe o erro (o serviço de definição)
 * prefixa `/schema`.
 *
 * Além do metaschema e da compilação, `checkSchema` recusa regex que pode explodir em tempo (ReDoS):
 * todo `pattern` e toda chave de `patternProperties` passam pela `safe-regex2`, e todo `pattern`
 * exige `maxLength` inteiro de até `PATTERN_MAX_LENGTH` no mesmo subschema. Esses erros saem com o
 * `path` do campo (`.../pattern`, relativo ao schema) e `code` `invalid-schema`.
 *
 * O `maxLength` protege o `validate`: o ajv o avalia antes do `pattern` e, sem `allErrors`, para no
 * primeiro erro, então o regex nunca roda sobre string acima do teto. Isso não vale para a chave de
 * `patternProperties`, que casa com nomes de propriedade sem teto. Limite conhecido: a `safe-regex2`
 * é heurística (altura de estrela e número de repetições), então alternância sobreposta como
 * `(a|aa)+` passa, e o teto de `PATTERN_MAX_LENGTH` limita o texto que ela consome, sem torná-la
 * barata.
 *
 * Outro limite conhecido, aceito: o percurso do `checkSchema` não segue `$ref`. Um `$ref` com
 * ponteiro para dentro de dado (`#/const`, `#/default`, `#/enum/N`, `#/examples/N`) compila, e o
 * `pattern` que está lá escapa da `safe-regex2` e do teto de `maxLength`. A ferramenta é de uso
 * exclusivo de agentes de IA, e o único cenário é injeção de prompt, cujo efeito é travar o
 * servidor, sem vazar dado. A correção barata, se um dia valer, é uma allowlist de `$ref` (`#`,
 * `#/$defs/...`, `#/definitions/...`).
 */
export function createValidator(): Validator {
  const checker = createCompiler(true);
  const dataValidator = createCompiler(false);

  return {
    checkSchema(schema) {
      try {
        if (!checker.ajv.validateSchema(schema)) return toDetails(checker.ajv.errors ?? []);
        checker.compile(schema);
        return patternDetails(schema);
      } catch (error) {
        // Modo estrito (palavra-chave ou formato desconhecido), `$ref` sem destino, `$schema` de
        // outro rascunho, `$id` repetido e `$async` saem como exceção, sem ponto no schema: o erro
        // aponta a raiz do documento (`path` vazio), como os do metaschema são relativos a ele.
        return [{ path: '', code: 'invalid-schema', message: (error as Error).message }];
      }
    },
    validate(schema, data) {
      const validate = dataValidator.compile(schema);
      return validate(data) ? [] : toDetails(validate.errors ?? []);
    },
  };
}
