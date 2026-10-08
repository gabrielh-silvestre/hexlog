import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isUndefined, kebabCase, memoize, type MemoizeCache } from 'es-toolkit';
import { ATTACHMENT_FORMAT } from '../domain/definitions.ts';
import { catalogNames, FORMAT_CATALOG } from '../domain/formats.ts';
import { Hash } from '../domain/ids.ts';
import { FREE_PATTERN_KEYWORDS, hasKeywordAt, walkSubschemas } from '../domain/schema-walk.ts';
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
    path: isUndefined(property) ? error.instancePath : error.instancePath + jsonPointer([property]),
    code: kebabCase(error.keyword),
    message: error.message ?? 'schema validation failed',
  };
}

const toDetails = (errors: ErrorObject[]): Detail[] => capDetails(errors.map(toDetail));

/** As duas posições em que `attachmentFields` reconhece a marca: o campo e os itens dele. */
const ATTACHMENT_MARK_POSITION = /^\/properties\/[^/]+(\/items)?$/;

const MISPLACED_ATTACHMENT_MESSAGE =
  `format "${ATTACHMENT_FORMAT}" is only recognised on a top-level property ` +
  '(/properties/<field>) or on the items of a top-level list (/properties/<field>/items); ' +
  'for an optional attachment use type: ["string","null"], or a list whose items carry the mark';

const freePatternDetail = (path: string, keyword: string): Detail => ({
  path,
  code: 'pattern-not-allowed',
  message:
    `${keyword} is not allowed in a type schema; use a catalog format ` +
    `(${catalogNames().join(', ')}) or plain minLength/maxLength`,
});

/**
 * Percorre só as palavras-chave que carregam subschemas (nunca `const`/`enum`/`default`, que são
 * dado) e aponta cada `pattern` e cada `patternProperties` (`pattern-not-allowed`) e cada
 * `format: "attachment"` fora das posições que `attachmentFields` reconhece. Puro: não chama o ajv.
 */
function ruleDetails(root: unknown): Detail[] {
  const details: Detail[] = [];

  walkSubschemas(root, (node, pointer) => {
    if (node.format === ATTACHMENT_FORMAT && !ATTACHMENT_MARK_POSITION.test(pointer))
      details.push({
        path: `${pointer}/format`,
        code: 'invalid-schema',
        message: MISPLACED_ATTACHMENT_MESSAGE,
      });

    for (const keyword of FREE_PATTERN_KEYWORDS) {
      if (Object.hasOwn(node, keyword))
        details.push(freePatternDetail(`${pointer}/${keyword}`, keyword));
    }
  });

  return capDetails(details);
}

const NEVER_MATCHES = { test: (): boolean => false };
// `code` é obrigatório em `RegExpEngine` (TS2741 sem ele) e não pode ser "new RegExp".
const INERT_ENGINE = Object.assign(() => NEVER_MATCHES, { code: 'inert-regexp' });

/** Recebe a palavra-chave e o lugar (ponteiro RFC 6901) do subschema que a carrega. */
type FreePatternSink = (keyword: string, location: string) => void;

/** Ajv estrito com os formatos do `ajv-formats`, o `attachment` (D-16) e os de `FORMAT_CATALOG`. */
function createAjv(options: ConstructorParameters<typeof Ajv2020.default>[0]) {
  const ajv = new Ajv2020.default({ strict: true, logger: false, ...options });
  addFormats.default(ajv);
  // Formato `attachment`: o mesmo `Hash` do domínio (sha256 em hexadecimal minúsculo).
  ajv.addFormat(ATTACHMENT_FORMAT, (value: string) => Hash.safeParse(value).success);
  for (const [name, test] of Object.entries(FORMAT_CATALOG)) ajv.addFormat(name, test);
  return ajv;
}

/**
 * Compilador neutro: `pattern` e `patternProperties` não são aplicados e o motor de regex do ajv
 * nunca casa, então nenhum regex vindo do schema é construído nem executado. Só o `removeKeyword`
 * não basta, porque `additionalProperties` lê `patternProperties` direto e o executa. O ajv não
 * revalida o schema (`validateSchema: false`): quem o confere é a instância `meta`. Com `sink`, as
 * duas palavras-chave gravam cada ocorrência no documento compilado, inclusive a que um `$ref`
 * alcança dentro de dado, sem construir o regex.
 */
function createCompiler(allErrors: boolean, sink?: FreePatternSink) {
  const ajv = createAjv({ allErrors, code: { regExp: INERT_ENGINE }, validateSchema: false });
  let root: unknown;
  for (const keyword of FREE_PATTERN_KEYWORDS) {
    ajv.removeKeyword(keyword);
    ajv.addKeyword({
      keyword,
      code: (cxt) => {
        // Só o documento do agente conta: o `$ref` para o metaschema compila sem recusa.
        if (isUndefined(sink) || cxt.it.schemaEnv.root.schema !== root) return;
        sink(keyword, decodeURIComponent(cxt.it.errSchemaPath.replace(/^#/, '')));
      },
    });
  }

  const compile = (schema: Record<string, unknown>) => {
    // O `removeSchema` do `finally` apaga por `$id`: com um `$id` que o ajv já conhece (os
    // metaschemas) ele levaria o schema alheio junto. `$id` vazio ou `#` não nomeia nada (o ajv o
    // trata como ausente) e `getSchema` devolveria o resíduo que um schema anterior sem `$id` deixa.
    const id = schema.$id;
    if (typeof id === 'string' && id !== '' && id !== '#' && ajv.getSchema(id)) {
      throw new Error(`schema with $id "${id}" is already registered`);
    }
    root = schema;
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

  return { compile };
}

/** O ajv estoura a pilha ao compilar `$ref` cíclico (`a` aponta `b`, `b` aponta `a`): `RangeError` cru não ajuda o agente. */
function messageOf(error: unknown): string {
  if (error instanceof RangeError) return 'schema has a cyclic $ref or is nested too deeply';
  return (error as Error).message;
}

/**
 * Validador JSON Schema (2020-12) com ajv estrito e `ajv-formats`, mais o formato `attachment` e os
 * do `FORMAT_CATALOG`. O `$id` de um schema não fica registrado no ajv: `validate` compila uma vez
 * por objeto de schema e esquece o `$id`, então duas versões de um tipo com o mesmo `$id` em objetos
 * distintos não colidem.
 *
 * Três instâncias do ajv: `meta` só confere o schema contra o metaschema (`allErrors: true`, erros
 * estruturados); `checker` compila para `checkSchema` e devolve todos os erros (`allErrors: true`);
 * `validate` usa `allErrors: false` e devolve um erro por subschema avaliado, não um por campo (em
 * `anyOf`/`oneOf`/`propertyNames` saem os dos ramos). `checker` e `validate` são neutros: ignoram
 * `pattern` e `patternProperties` e nunca constroem regex do schema (`createCompiler`). O `meta`
 * também não constrói: `validateSchema` do ajv não executa o regex do schema.
 *
 * O `path` de `checkSchema` é sempre relativo ao documento do schema (raiz = `''`), inclusive nos
 * erros de compilação, que saem com `path` vazio; quem expõe o erro (o serviço de definição)
 * prefixa `/schema`.
 *
 * `checkSchema` recusa `pattern` e `patternProperties` (`pattern-not-allowed`): o hexlog não aplica
 * regex livre, o formato de um campo vem do catálogo (`FORMAT_CATALOG`) ou de `minLength`/`maxLength`.
 * A varredura pura (`ruleDetails`) roda antes de qualquer ajv e aponta cada ocorrência nos
 * subschemas; o `checker` grava as que só um `$ref` para dado (`#/const`, `#/examples/N`...) alcança,
 * com o `path` do lugar quando o ponteiro resolve no documento e vazio quando não (`$id` aninhado).
 * `$ref` para o metaschema do JSON Schema não é recusado.
 *
 * A marca `format: "attachment"` só vale em `/properties/<campo>` e `/properties/<campo>/items`,
 * as duas posições que `attachmentFields` reconhece; em qualquer outra (aninhada, `anyOf`, `$defs`)
 * o `checkSchema` recusa com `.../format`, porque o `register` nunca conferiria o anexo ali.
 *
 * Resíduo aceito: `format: "regex"` do `ajv-formats` constrói um `RegExp` sobre o dado (nunca sobre
 * o schema) e não o executa.
 */
export function createValidator(): Validator {
  const meta = createAjv({ allErrors: true });
  const freePatterns: { keyword: string; location: string }[] = [];
  const checker = createCompiler(true, (keyword, location) =>
    freePatterns.push({ keyword, location }),
  );
  // Chave por identidade do objeto: o lote de um `register` repete o mesmo schema e recompilar
  // custava 200 a 300 ms por lote de 50. Escopo da instância e coletável: o `WeakMap` não tem
  // `size`, que `MemoizeCache` exige no tipo mas o `memoize` nunca lê, então o cast é necessário.
  const compiledBy = (compiler: ReturnType<typeof createCompiler>) =>
    memoize((schema: Record<string, unknown>) => compiler.compile(schema), {
      cache: new WeakMap() as unknown as MemoizeCache<object, ReturnType<typeof compiler.compile>>,
    });
  const compiled = compiledBy(createCompiler(false));

  return {
    checkSchema(schema) {
      try {
        const rules = ruleDetails(schema);
        if (rules.length > 0) return rules;
        // `validateSchema` antes de `compile`: os erros do metaschema saem estruturados, cada um
        // com o seu path, e o `compile` neutro não os conferiria.
        if (!meta.validateSchema(schema)) return toDetails(meta.errors ?? []);
        freePatterns.length = 0;
        checker.compile(schema);
        return capDetails(
          freePatterns.map(({ keyword, location }) =>
            freePatternDetail(
              hasKeywordAt(schema, location, keyword) ? `${location}/${keyword}` : '',
              keyword,
            ),
          ),
        );
      } catch (error) {
        // Modo estrito (palavra-chave ou formato desconhecido), `$ref` sem destino, `$schema` de
        // outro rascunho, `$id` repetido e `$async` saem como exceção, sem ponto no schema: o erro
        // aponta a raiz do documento (`path` vazio), como os do metaschema são relativos a ele.
        return [{ path: '', code: 'invalid-schema', message: messageOf(error) }];
      }
    },
    validate(schema, data) {
      const validate = compiled(schema);
      return validate(data) ? [] : toDetails(validate.errors ?? []);
    },
  };
}
