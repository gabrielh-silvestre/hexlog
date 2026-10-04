import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isPlainObject, kebabCase } from 'es-toolkit';
import safeRegex from 'safe-regex2';
import { Hash } from '../domain/ids.ts';
import { capDetails, pointer as jsonPointer, type Detail } from '../errors.ts';
import type { Validator } from '../ports.ts';

/** Propriedade que o ajv só cita em `params`: o `instancePath` do erro aponta para o objeto pai. */
function offendingProperty(error: ErrorObject): string | undefined {
  const params = error.params as Record<string, unknown>;
  const name =
    params.missingProperty ??
    params.additionalProperty ??
    params.unevaluatedProperty ??
    params.propertyName ??
    error.propertyName;
  return typeof name === 'string' ? name : undefined;
}

function toDetail(error: ErrorObject): Detail {
  const property = offendingProperty(error);
  return {
    path:
      property === undefined ? error.instancePath : error.instancePath + jsonPointer([property]),
    code: kebabCase(error.keyword),
    message: error.message ?? 'schema validation failed',
  };
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
 * A `safe-regex2` devolve só booleano, então a mensagem cobre todas as causas possíveis da recusa;
 * o motivo do falso positivo está em `createValidator`.
 */
const UNSAFE_REGEX_MESSAGE =
  'regex rejected by safe-regex2: it may backtrack catastrophically or use syntax it cannot ' +
  'parse (e.g. lookbehind); a repeated group that contains a repetition, such as (-[a-z]+)*, is ' +
  'rejected even when linear. Rewrite it with a single character class (^[a-z0-9-]+$) or ' +
  'without a repeated group';

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
      if (!safeRegex(node.pattern)) reject(path, UNSAFE_REGEX_MESSAGE);
      if (typeof node.maxLength !== 'number' || node.maxLength > PATTERN_MAX_LENGTH)
        reject(
          path,
          `pattern requires a maxLength of at most ${PATTERN_MAX_LENGTH} in the same subschema`,
        );
    }
    if (isPlainObject(node.patternProperties)) {
      for (const key of Object.keys(node.patternProperties)) {
        if (!safeRegex(key))
          reject(`${pointer}/patternProperties${jsonPointer([key])}`, UNSAFE_REGEX_MESSAGE);
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
        visit(child, `${pointer}/${key}${jsonPointer([name])}`);
    }
  };

  visit(root, '');
  return capDetails(details);
}

/** Mesmas opções estritas e mesmos formatos nas duas instâncias; só `allErrors` muda. */
function createCompiler(allErrors: boolean) {
  const ajv = new Ajv2020.default({ strict: true, allErrors, logger: false });
  addFormats.default(ajv);
  // Formato `attachment` (D-16): o mesmo `Hash` do domínio (sha256 em hexadecimal minúsculo).
  ajv.addFormat('attachment', (value: string) => Hash.safeParse(value).success);

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

/** O ajv estoura a pilha ao compilar `$ref` cíclico (`a` aponta `b`, `b` aponta `a`): `RangeError` cru não ajuda o agente. */
function messageOf(error: unknown): string {
  if (error instanceof RangeError) return 'schema has a cyclic $ref or is nested too deeply';
  return (error as Error).message;
}

/**
 * Validador JSON Schema (2020-12) com ajv estrito e `ajv-formats`, mais o formato `attachment`.
 * O `$id` de um schema não fica registrado no ajv: `validate` compila uma vez por objeto de schema
 * e esquece o `$id`, então duas versões de um tipo com o mesmo `$id` em objetos distintos não
 * colidem.
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
 * O `maxLength` só impede que o `validate` rode o regex sobre string acima do teto (o ajv o avalia
 * antes do `pattern` e, sem `allErrors`, para no primeiro erro). Ele NÃO limita o dano de um regex
 * exponencial que a `safe-regex2` deixa passar: ela é heurística (altura de estrela e número de
 * repetições), então alternância sobreposta como `(a|aa)+` ou `([a-z]|[a-z0-9])+` passa, e com
 * 27 caracteres, bem abaixo do teto de `PATTERN_MAX_LENGTH`, a medição deu cerca de 8 s. Risco
 * aceito pelo usuário em 2026-10-02: a ferramenta é de uso exclusivo de agentes. O teto também não
 * vale para a chave de `patternProperties`, que casa com nomes de propriedade sem limite.
 *
 * A `safe-regex2` também tem falso positivo: recusa regex linear com repetição dentro de grupo
 * repetido (`^[a-z]+(?:-[a-z]+)*$`) e sintaxe que não parseia (lookbehind). Passam classe única
 * (`^[a-z0-9-]+$`) e sequência sem grupo repetido; a mensagem de recusa já diz isso.
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
  // Chave por identidade do objeto: o lote de um `register` repete o mesmo schema e recompilar
  // custava 200 a 300 ms por lote de 50. Escopo da instância e coletável.
  const compiled = new WeakMap<object, ValidateFunction>();

  return {
    checkSchema(schema) {
      try {
        // `validateSchema` antes de `compile`: o `compile` também confere o metaschema, mas lança um
        // texto único (`schema is invalid: ...`); aqui os erros saem estruturados, cada um com o seu path.
        if (!checker.ajv.validateSchema(schema)) return toDetails(checker.ajv.errors ?? []);
        checker.compile(schema);
        return patternDetails(schema);
      } catch (error) {
        // Modo estrito (palavra-chave ou formato desconhecido), `$ref` sem destino, `$schema` de
        // outro rascunho, `$id` repetido e `$async` saem como exceção, sem ponto no schema: o erro
        // aponta a raiz do documento (`path` vazio), como os do metaschema são relativos a ele.
        return [{ path: '', code: 'invalid-schema', message: messageOf(error) }];
      }
    },
    validate(schema, data) {
      let validate = compiled.get(schema);
      if (!validate) {
        validate = dataValidator.compile(schema);
        compiled.set(schema, validate);
      }
      return validate(data) ? [] : toDetails(validate.errors ?? []);
    },
  };
}
