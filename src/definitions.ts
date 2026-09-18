import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import canonicalize from 'canonicalize';
import { difference, isNil, mapValues, pick, union } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { z } from 'zod';
import { anchor, sha256hex } from './chain.ts';
import { resolveSafePath, ioError, readJson } from './storage.ts';
import { HexlogError, type Detail } from './errors.ts';
import { Hash, Name } from './events.ts';
import { CLOSED_VOCAB_KEYS } from './state.ts';
import type { Vocab, Vocabulary } from './state.ts';

// Reexportados de state.ts (fonte única do schema de vocabulário, DE-29).
export type { Vocab, Vocabulary };

/** §4.2: nomes de processo reservados para as definições do projeto. */
export const RESERVED_PROCESS_NAMES = ['schemas', 'vocabulary', 'gates'] as const;

/** §4.2: nomes de tipo reservados para os eventos nativos. */
export const RESERVED_TYPE_NAMES = ['milestone', 'verdict'] as const;

/** §4.11: nomes de gate embutidos, reservados para `register_gate`. */
export const BUILTIN_GATE_NAMES = [
  'no-orphans',
  'no-conflicts',
  'chain-intact',
  'no-invalid-references',
  'no-forks',
] as const;

/** Teto de caracteres canônicos (JCS) para um schema custom (§4.10). */
const SCHEMA_MAX_CHARS = 16_000;

/** Logger opcional injetável no Ajv (§4.10): por padrão, nenhum log vai para stdout/stderr. */
export type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/**
 * Resposta comum de `register_type`/`register_gate`: o que foi gravado e sua versão (§4.10/§4.11).
 * Schema Zod é a fonte única, mcp.ts só reexporta; `definition-tools.ts` usa `.shape` e adiciona
 * `warnings` (schema `Warning` vive em `mcp.ts`, camada acima — evita import circular daqui).
 */
export const Registered = z.object({
  project: Name,
  name: Name,
  hash: Hash,
  version: z.string(),
  previousVersion: z.string().nullable(),
  unchanged: z.boolean(),
});
export type Registered = z.infer<typeof Registered>;

/** Aviso não-fatal de `register_*` (§4.12): mesmo shape do schema Zod `Warning` de `mcp.ts:44-48`. */
export type Warning = { code: string; message: string; details?: unknown };

/** Campos de versionamento comuns aos três `register_*` (levas 3-5): só o identificador varia. */
type VersionedRegistration = {
  hash: string;
  version: string;
  previousVersion: string | null;
  unchanged: boolean;
  warnings: Warning[];
};

/** Hashes dos três blocos fixados no `process.json` (§4.1): schema Zod é a fonte única. */
export const Hashes = z.object({ schemas: Hash, vocabulary: Hash, gates: Hash });
export type Hashes = z.infer<typeof Hashes>;

/** Versão vigente de cada definição fixada no momento do `createProcess` (§4.1, leva 6). Schema Zod é a fonte única. */
export const FixedVersions = z.object({
  types: z.record(z.string(), z.string()),
  vocabulary: z.record(z.string(), z.string()),
  gates: z.record(z.string(), z.string()),
});
export type FixedVersions = z.infer<typeof FixedVersions>;

/**
 * Manifesto fixado de um processo (`process.json`, §4.1). `versions` é informativo: fica **fora**
 * de `hashes`/`fixed` (não entra em `verifyHashes`) e é opcional para aceitar sem erro um
 * `process.json` legado gravado antes da leva 6, que nunca teve esse campo.
 */
export type ProcessManifest = {
  project: string;
  process: string;
  createdAt: string;
  fixed: {
    types: Record<string, object>;
    vocabulary: Vocabulary;
    gates: Record<string, { criteria: string }>;
  };
  hashes: Hashes;
  versions?: FixedVersions;
};

/** Processo carregado e pronto para uso: manifesto verificado, âncora e schemas Zod dos tipos custom. */
export type LoadedProcess = {
  manifest: ProcessManifest;
  anchor: string;
  customSchemas: Record<string, z.ZodType>;
  processDir: string;
  eventsFile: string;
};

const EMPTY_VOCAB: Vocab = { milestoneType: [], result: [], action: [] };

/** Parâmetros de `decideVersion` — extraído para ser reaproveitado por `registerVersioned`. */
type DecideVersionParams<T> = {
  current: { version: string; content: T } | null;
  candidateContent: T;
  candidateHash: string;
  content: Record<string, unknown>;
  breakingInput: boolean;
  detectBreak: (current: T, candidate: T) => { breaking: boolean; details: Detail[] };
};

/**
 * Decisão de versionamento compartilhada pelos três `register_*` (levas 3-5): resolve o `outcome`
 * a passar a `writeVersionExclusive` (D1) a partir do vigente lido nesta tentativa, mais
 * `previousVersion`/`warnings` pra montar a resposta final. Genérica sobre `T` (o conteúdo
 * comparável — `Vocab`, o schema JSON, ou a `criteria` do gate) pra injetar `detectBreak` sem
 * alargar sua assinatura pra `Record<string, unknown>`, o que sob TS estrito falharia por
 * contravariância de parâmetros.
 *
 * A ordem importa: `unchanged` (hash do candidato == hash do vigente) é checado **antes** de
 * chamar `detectBreak` — é isso que faz conteúdo idêntico ser sempre no-op, mesmo pra `type`,
 * cujo `detectBreak` devolve quebra sempre que é chamado.
 */
function decideVersion<T>(params: DecideVersionParams<T>): {
  outcome: ResolveOutcome;
  previousVersion: string | null;
  warnings: Warning[];
} {
  const { current, candidateContent, candidateHash, content, breakingInput, detectBreak } = params;
  const previousVersion = current?.version ?? null;

  if (isNil(current)) {
    return { outcome: { kind: 'write', version: '1.0', content }, previousVersion, warnings: [] };
  }

  if (sha256hex(canonicalize(current.content) ?? '') === candidateHash) {
    return {
      outcome: { kind: 'unchanged', version: current.version },
      previousVersion,
      warnings: [],
    };
  }

  const { breaking, details } = detectBreak(current.content, candidateContent);
  if (breaking && !breakingInput) {
    return { outcome: { kind: 'breaking', details }, previousVersion, warnings: [] };
  }

  const warnings: Warning[] =
    !breaking && breakingInput
      ? [
          {
            code: 'NO_BREAKING_CHANGE',
            message: 'breaking:true was passed but the change is compatible',
          },
        ]
      : [];

  const version = formatVersion(bumpVersion(current.version, breaking ? 'major' : 'minor'));
  return { outcome: { kind: 'write', version, content }, previousVersion, warnings };
}

/**
 * Wiring de versionamento comum aos três `register_*` (levas 3-5): resolve o vigente em `partDir`
 * e delega a decisão a `decideVersion` (ver seu JSDoc pro porquê de `T` genérico), gravando com
 * `writeVersionExclusive`. `projectCurrent` extrai de `current.content` (JSON bruto do disco) só
 * o pedaço comparável de tipo `T`.
 */
function registerVersioned<T>(
  partDir: string,
  defDir: string,
  key: string,
  projectCurrent: (content: Record<string, unknown>) => T,
  decision: Omit<DecideVersionParams<T>, 'current'>,
): { result: WriteVersionResult; previousVersion: string | null; warnings: Warning[] } {
  let previousVersion: string | null = null;
  let warnings: Warning[] = [];

  const resolveTarget = (): ResolveOutcome => {
    const current = resolveCurrentDefinition(partDir, key);
    const decided = decideVersion<T>({
      ...decision,
      current: isNil(current)
        ? null
        : { version: current.version, content: projectCurrent(current.content) },
    });
    previousVersion = decided.previousVersion;
    warnings = decided.warnings;
    return decided.outcome;
  };

  const result = writeVersionExclusive(defDir, resolveTarget);
  return { result, previousVersion, warnings };
}

/**
 * §4.10: registra (versionado) o schema JSON custom de `name`, gravando `schemas/<name>/<versão>.json`.
 * Sem vigente (nome novo) → `1.0` direto. Conteúdo igual ao vigente → `unchanged`, nada escrito.
 * Qualquer outra mudança de schema é sempre quebra (regra do spec: "qualquer mudança no schema
 * JSON"): exige `breaking: true` (senão lança `BREAKING_CHANGE`) e bumpa major; com `breaking: true`
 * também bumpa major, sem aviso (nunca há mudança compatível pra um schema, então `NO_BREAKING_CHANGE`
 * nunca dispara aqui — ao contrário de vocabulário e gate).
 */
export function registerType(
  dir: string,
  project: string,
  name: string,
  schema: Record<string, unknown>,
  options: { log?: Logger; breaking?: boolean } = {},
): { project: string; name: string } & VersionedRegistration {
  if ((RESERVED_TYPE_NAMES as readonly string[]).includes(name)) {
    throw new HexlogError('RESERVED_NAME', `type '${name}' is reserved`);
  }

  const canonicalSchema = canonicalize(schema) ?? '';
  if (canonicalSchema.length > SCHEMA_MAX_CHARS) {
    throw new HexlogError(
      'INVALID_SCHEMA',
      `schema exceeds ${SCHEMA_MAX_CHARS} canonical characters`,
      [
        {
          path: '/schema',
          code: 'too_big',
          message: `canonical size ${canonicalSchema.length}`,
        },
      ],
    );
  }

  validateWithAjv(schema, options.log);

  if (schema.type !== 'object') {
    throw new HexlogError('INVALID_SCHEMA', 'schema root must be "type": "object"', [
      { path: '/schema/type', code: 'invalid_type', message: 'expected "object"' },
    ]);
  }

  try {
    z.fromJSONSchema(schema);
  } catch {
    // a mensagem bruta do zod não é exposta (§4.10): só o código de domínio.
    throw new HexlogError('INVALID_SCHEMA', 'unsupported schema construct', [
      {
        path: '/schema',
        code: 'unsupported',
        message: 'unsupported schema construct',
      },
    ]);
  }

  const partDir = resolveSafePath(dir, project, 'schemas');
  const defDir = resolveSafePath(dir, project, 'schemas', name);
  const hash = sha256hex(canonicalSchema);
  const content: Record<string, unknown> = {
    name,
    schema,
    hash,
    registeredAt: new Date().toISOString(),
  };

  const { result, previousVersion, warnings } = registerVersioned<Record<string, unknown>>(
    partDir,
    defDir,
    name,
    (c) => c.schema as Record<string, unknown>,
    {
      candidateContent: schema,
      candidateHash: hash,
      content,
      breakingInput: options.breaking === true,
      detectBreak: () => ({
        breaking: true,
        details: [{ path: '/schema', code: 'changed', message: 'schema changed' }],
      }),
    },
  );

  return {
    project,
    name,
    hash,
    version: result.version,
    previousVersion,
    unchanged: result.kind === 'unchanged',
    warnings,
  };
}

/** Ajv2020 strict + ajv-formats: pega typo de keyword, forma malformada e `$ref` externo. */
function validateWithAjv(schema: Record<string, unknown>, log: Logger | undefined): void {
  try {
    const ajv = new Ajv2020.default({ strict: true, allErrors: true, logger: log ?? false });
    addFormats.default(ajv);
    ajv.compile(schema);
  } catch (e) {
    const instancePath = (e as { instancePath?: string }).instancePath;
    const errorPath = isNil(instancePath) ? '/schema' : `/schema${instancePath}`;
    throw new HexlogError('INVALID_SCHEMA', 'schema rejected by Ajv', [
      { path: errorPath, code: 'ajv_invalid', message: (e as Error).message },
    ]);
  }
}

/**
 * Quebra de vocabulário (§4.9): termo presente no vigente e ausente no candidato, só nas
 * chaves fechadas de `CLOSED_VOCAB_KEYS` — `result` é campo aberto e nunca entra aqui.
 * `details[].path` é a chave do `Vocab` comparado (`/milestoneType`, `/action`), não o path de
 * runtime de `VOCABULARY_VIOLATED` (`/data/milestoneType`, `/data/decisions/${index}/action`),
 * que tem prefixo e índice de array que não existem ao comparar duas definições estáticas.
 */
function detectVocabularyBreak(
  current: Vocab,
  next: Vocab,
): { breaking: boolean; details: Detail[] } {
  const details: Detail[] = [];
  for (const key of CLOSED_VOCAB_KEYS) {
    for (const term of difference(current[key], next[key])) {
      details.push({
        path: `/${key}`,
        code: 'removed',
        message: `term removed from ${key}: ${term}`,
      });
    }
  }
  return { breaking: !isEmpty(details), details };
}

/**
 * §4.9: registra (versionado) o vocabulário de `owner` (`"core"` ou uma extensão), gravando
 * `vocabulary/<owner>/<versão>.json`. Sem vigente (nome novo) → `1.0` direto. Conteúdo igual ao
 * vigente → `unchanged`, nada escrito. Termo fechado removido → quebra: exige `breaking: true`
 * (senão lança `BREAKING_CHANGE`) e bumpa major; sem quebra bumpa minor, e `breaking: true` numa
 * mudança compatível vira aviso `NO_BREAKING_CHANGE` em vez de forçar major. O arquivo legado
 * `vocabulary/<owner>.json`, se existir, nunca é apagado, reescrito ou materializado como `1.0.json`.
 */
export function registerVocabulary(
  dir: string,
  project: string,
  owner: string,
  vocab: Vocab,
  options: { breaking?: boolean } = {},
): { project: string; owner: string } & VersionedRegistration {
  const partDir = resolveSafePath(dir, project, 'vocabulary');
  const defDir = resolveSafePath(dir, project, 'vocabulary', owner);
  const hash = sha256hex(canonicalize(vocab) ?? '');
  const content: Record<string, unknown> = {
    owner,
    ...vocab,
    hash,
    registeredAt: new Date().toISOString(),
  };

  const { result, previousVersion, warnings } = registerVersioned<Vocab>(
    partDir,
    defDir,
    owner,
    extractVocab,
    {
      candidateContent: vocab,
      candidateHash: hash,
      content,
      breakingInput: options.breaking === true,
      detectBreak: detectVocabularyBreak,
    },
  );

  return {
    project,
    owner,
    hash,
    version: result.version,
    previousVersion,
    unchanged: result.kind === 'unchanged',
    warnings,
  };
}

/**
 * §4.11: registra (versionado) o critério de um gate custom, gravando `gates/<name>/<versão>.json`.
 * Sem vigente (nome novo) → `1.0` direto. Conteúdo igual ao vigente → `unchanged`, nada escrito.
 * Gate nunca quebra (tabela do spec, "Major quando: nunca"): qualquer mudança de `criteria` bumpa
 * minor, sem exigir flag; `breaking: true` numa mudança de gate sempre vira aviso `NO_BREAKING_CHANGE`.
 */
export function registerGate(
  dir: string,
  project: string,
  name: string,
  criteria: string,
  options: { breaking?: boolean } = {},
): { project: string; name: string } & VersionedRegistration {
  if ((BUILTIN_GATE_NAMES as readonly string[]).includes(name)) {
    throw new HexlogError('RESERVED_NAME', `gate '${name}' is builtin`);
  }

  const partDir = resolveSafePath(dir, project, 'gates');
  const defDir = resolveSafePath(dir, project, 'gates', name);
  const hash = sha256hex(canonicalize(criteria) ?? '');
  const content: Record<string, unknown> = {
    name,
    criteria,
    hash,
    registeredAt: new Date().toISOString(),
  };

  const { result, previousVersion, warnings } = registerVersioned<string>(
    partDir,
    defDir,
    name,
    (c) => c.criteria as string,
    {
      candidateContent: criteria,
      candidateHash: hash,
      content,
      breakingInput: options.breaking === true,
      detectBreak: () => ({ breaking: false, details: [] }),
    },
  );

  return {
    project,
    name,
    hash,
    version: result.version,
    previousVersion,
    unchanged: result.kind === 'unchanged',
    warnings,
  };
}

/**
 * §4.1: fixa o snapshot atual de definições do projeto num novo `process.json`, criado exclusivamente.
 * Idempotente (P3): se o processo já existir — seja por uma chamada anterior, seja por perder a
 * corrida do link exclusivo — compara `hashes` com o candidato desta chamada em vez de lançar.
 * Hashes iguais devolve o processo existente (`existed: true`, sem aviso); hashes diferentes também
 * devolve o existente, mas com o aviso `STALE_DEFINITIONS` apontando o que mudou desde a fixação.
 */
export function createProcess(
  dir: string,
  project: string,
  process: string,
  clock: () => Date,
): {
  project: string;
  process: string;
  createdAt: string;
  hashes: Hashes;
  types: string[];
  owners: string[];
  gates: string[];
  versions: FixedVersions;
  existed: boolean;
  warnings: Warning[];
} {
  if ((RESERVED_PROCESS_NAMES as readonly string[]).includes(process)) {
    throw new HexlogError('RESERVED_NAME', `process '${process}' is reserved`);
  }

  const projectDir = resolveSafePath(dir, project);
  const { fixed, versions } = buildSnapshot(projectDir);
  const hashes: Hashes = {
    schemas: sha256hex(canonicalize(fixed.types) ?? ''),
    vocabulary: sha256hex(canonicalize(fixed.vocabulary) ?? ''),
    gates: sha256hex(canonicalize(fixed.gates) ?? ''),
  };
  const createdAt = clock().toISOString();
  const candidate: ProcessManifest = { project, process, createdAt, fixed, hashes, versions };

  const { manifest, existed, warnings } = createOrCompareProcess(
    resolveSafePath(projectDir, process),
    candidate,
  );

  return {
    project,
    process,
    createdAt: manifest.createdAt,
    hashes: manifest.hashes,
    types: Object.keys(manifest.fixed.types),
    owners: Object.keys(manifest.fixed.vocabulary.byOwner),
    gates: Object.keys(manifest.fixed.gates),
    versions: manifest.versions ?? versions,
    existed,
    warnings,
  };
}

/** Detalhe de `STALE_DEFINITIONS` (P3): versão fixada no `process.json` existente × a vigente agora. */
type StaleDetail = {
  section: keyof FixedVersions;
  name: string;
  pinned: string | null;
  current: string | null;
};

const VERSION_SECTIONS: (keyof FixedVersions)[] = ['types', 'vocabulary', 'gates'];

/** Compara `versions` fixado × candidato, seção a seção, e lista só o que divergiu. */
function detectStaleVersions(
  pinned: FixedVersions | undefined,
  current: FixedVersions | undefined,
): StaleDetail[] {
  return VERSION_SECTIONS.flatMap((section) => {
    const pinnedSection = pinned?.[section] ?? {};
    const currentSection = current?.[section] ?? {};
    const names = union(Object.keys(pinnedSection), Object.keys(currentSection));
    return names
      .filter((name) => pinnedSection[name] !== currentSection[name])
      .map((name) => ({
        section,
        name,
        pinned: pinnedSection[name] ?? null,
        current: currentSection[name] ?? null,
      }));
  });
}

/**
 * §4.1.1: cria `process.json` exclusivamente (vence quem chega primeiro). Quem perde o `EEXIST` —
 * seja retentativa do agente, seja a corrida entre duas chamadas concorrentes — lê o vigente e
 * compara com o candidato desta chamada, em vez de lançar (P3).
 */
function createOrCompareProcess(
  processDir: string,
  candidate: ProcessManifest,
): { manifest: ProcessManifest; existed: boolean; warnings: Warning[] } {
  const file = path.join(processDir, 'process.json');
  try {
    writeThenLinkExclusive(processDir, file, candidate);
    return { manifest: candidate, existed: false, warnings: [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }

  const existing = readJson(file) as ProcessManifest;
  verifyHashes(existing);
  if (canonicalize(existing.hashes) === canonicalize(candidate.hashes)) {
    return { manifest: existing, existed: true, warnings: [] };
  }

  const details = detectStaleVersions(existing.versions, candidate.versions);
  return {
    manifest: existing,
    existed: true,
    warnings: [
      {
        code: 'STALE_DEFINITIONS',
        message: `process '${existing.process}' already exists with a different definitions snapshot`,
        details,
      },
    ],
  };
}

/** Conteúdo fixado de cada definição (inalterado) e a versão vigente de cada uma (bloco `versions`, leva 6). */
function buildSnapshot(projectDir: string): {
  fixed: ProcessManifest['fixed'];
  versions: FixedVersions;
} {
  const typeDefs = listDefinitions(path.join(projectDir, 'schemas'));
  const types = Object.fromEntries(typeDefs.map((d) => [d.name, d.content.schema as object]));

  const vocabFiles = listDefinitions(path.join(projectDir, 'vocabulary'));
  if (isEmpty(vocabFiles)) {
    throw new HexlogError('VOCABULARY_MISSING', 'no vocabulary registered in the project');
  }
  const coreFile = vocabFiles.find((d) => d.name === 'core');
  const vocabulary: Vocabulary = {
    core: isNil(coreFile) ? EMPTY_VOCAB : extractVocab(coreFile.content),
    byOwner: Object.fromEntries(
      vocabFiles.filter((d) => d.name !== 'core').map((d) => [d.name, extractVocab(d.content)]),
    ),
  };

  const gateDefs = listDefinitions(path.join(projectDir, 'gates'));
  const gates = Object.fromEntries(
    gateDefs.map((d) => [d.name, { criteria: d.content.criteria as string }]),
  );

  const versions: FixedVersions = {
    types: Object.fromEntries(typeDefs.map((d) => [d.name, d.version])),
    vocabulary: Object.fromEntries(vocabFiles.map((d) => [d.name, d.version])),
    gates: Object.fromEntries(gateDefs.map((d) => [d.name, d.version])),
  };

  return { fixed: { types, vocabulary, gates }, versions };
}

function extractVocab(content: Record<string, unknown>): Vocab {
  return pick(content, ['milestoneType', 'result', 'action']) as Vocab;
}

/**
 * Grava `content` num arquivo temporário em `dir` e o linka exclusivamente como `file`
 * (vence quem chega primeiro — usado tanto por `createOrCompareProcess` quanto por
 * `writeVersionExclusive`, D1). Sucesso: retorna. `EEXIST`: relança tal qual, sem
 * empacotar — cabe ao chamador decidir se isso é erro definitivo ou motivo de retry.
 * Qualquer outro erro de I/O já sai como `HexlogError('IO_ERROR')`. O `.tmp` é sempre
 * removido, sucesso ou falha.
 */
function writeThenLinkExclusive(dir: string, file: string, content: unknown): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${globalThis.process.pid}.${randomBytes(4).toString('hex')}`,
  );

  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(content, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.linkSync(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw e;
    throw ioError(e);
  } finally {
    fs.unlinkSync(tmp);
  }
}

/** Decisão completa de versionamento devolvida por `resolveTarget` a cada tentativa de `writeVersionExclusive`. */
export type ResolveOutcome =
  | { kind: 'write'; version: string; content: Record<string, unknown> }
  | { kind: 'unchanged'; version: string }
  | { kind: 'breaking'; details: Detail[] };

/** Resultado de `writeVersionExclusive`: o que foi de fato gravado, ou a confirmação de que nada mudou. */
type WriteVersionResult =
  | { kind: 'written'; version: string; content: Record<string, unknown> }
  | { kind: 'unchanged'; version: string };

/**
 * Grava em `defDir` (ex.: `schemas/<name>/`) a versão decidida por `resolveTarget` (D1).
 *
 * `resolveTarget` encapsula a decisão inteira de versionamento — resolver o vigente em
 * disco, checar `unchanged`, detectar quebra, bumpar — e é chamado do zero a cada
 * tentativa, inclusive a primeira: o vigente pode ter mudado entre duas invocações, seja
 * por um retry após `EEXIST`, seja porque a primeira leitura já estava desatualizada no
 * instante em que o `linkSync` de fato acontece. Não há atalho de "recalcular só o
 * número" fora do laço.
 */
export function writeVersionExclusive(
  defDir: string,
  resolveTarget: () => ResolveOutcome,
  maxAttempts = 10,
): WriteVersionResult {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const outcome = resolveTarget();

    if (outcome.kind === 'unchanged') return { kind: 'unchanged', version: outcome.version };
    if (outcome.kind === 'breaking') {
      throw new HexlogError('BREAKING_CHANGE', 'change requires breaking: true', outcome.details);
    }

    try {
      writeThenLinkExclusive(defDir, path.join(defDir, `${outcome.version}.json`), outcome.content);
      return { kind: 'written', version: outcome.version, content: outcome.content };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }

  throw new HexlogError('IO_ERROR', 'exclusive write did not succeed', [
    {
      path: '',
      code: 'exclusive_write_exhausted',
      message: `exclusive write did not succeed after ${maxAttempts} attempts`,
    },
  ]);
}

/** Carrega e verifica um processo: hashes internos recalculados, âncora e schemas Zod dos tipos custom. */
export function loadProcess(dir: string, project: string, process: string): LoadedProcess {
  const processDir = resolveSafePath(dir, project, process);
  const file = path.join(processDir, 'process.json');

  let loadedManifest: unknown;
  try {
    loadedManifest = readJson(file);
  } catch {
    throw new HexlogError('PROCESS_CORRUPTED', 'process.json unreadable', [
      { path: '', code: 'unreadable', message: 'process.json could not be read' },
    ]);
  }
  if (isNil(loadedManifest)) {
    throw new HexlogError('PROCESS_NOT_FOUND', `process '${process}' not found`);
  }

  const manifest = loadedManifest as ProcessManifest;
  verifyHashes(manifest);

  const customSchemas = mapValues(manifest.fixed.types, (schema) =>
    z.fromJSONSchema(schema as z.core.JSONSchema.JSONSchema),
  );

  return {
    manifest,
    anchor: anchor(manifest),
    customSchemas,
    processDir,
    eventsFile: path.join(processDir, 'events.jsonl'),
  };
}

/** Recalcula `hashes.X = sha256(canonicalize(fixed.X))` e compara com o gravado (§4.1). */
function verifyHashes(manifest: ProcessManifest): void {
  const parts: { hash: keyof ProcessManifest['hashes']; fixed: unknown }[] = [
    { hash: 'schemas', fixed: manifest.fixed.types },
    { hash: 'vocabulary', fixed: manifest.fixed.vocabulary },
    { hash: 'gates', fixed: manifest.fixed.gates },
  ];

  for (const part of parts) {
    const recalculated = sha256hex(canonicalize(part.fixed) ?? '');
    if (recalculated !== manifest.hashes[part.hash]) {
      throw new HexlogError(
        'PROCESS_CORRUPTED',
        `${part.hash} hash does not match the fixed snapshot`,
        [
          {
            path: `/hashes/${part.hash}`,
            code: 'hash_mismatch',
            message: 'recalculated hash differs from the stored one',
          },
        ],
      );
    }
  }
}

type DefinitionFile = { name: string; version: string; content: Record<string, unknown> };

/**
 * Definições vigentes de `partDir` (`schemas/`, `vocabulary/`, `gates/`): nomes vêm da união dos
 * arquivos `.json` soltos (legado) com os subdiretórios versionados (leva 3), sem duplicar um
 * nome presente nos dois; cada nome é resolvido para a sua vigente via `resolveCurrentDefinition`.
 */
function listDefinitions(partDir: string): DefinitionFile[] {
  const legacyNames = listDirectoryNames(
    partDir,
    (entry) => entry.isFile() && entry.name.endsWith('.json'),
  ).map((file) => path.basename(file, '.json'));
  const dirNames = listDirectoryNames(partDir, (entry) => entry.isDirectory());
  const names = union(legacyNames, dirNames);

  return names.flatMap((name) => {
    const current = resolveCurrentDefinition(partDir, name);
    return isNil(current) ? [] : [{ name, ...current }];
  });
}

/** Lê os nomes de entradas de `parentDir` que casam `filter`, ignorando `.`-prefixados; `[]` se o diretório não existe. */
function listDirectoryNames(parentDir: string, filter: (entry: fs.Dirent) => boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw ioError(e);
  }
  return entries
    .filter((entry) => !entry.name.startsWith('.') && filter(entry))
    .map((entry) => entry.name);
}

/** Um número de versão `major.minor` (ex.: `schemas/<name>/1.9.json`). */
type Version = { major: number; minor: number };

const VERSION_FILE_RE = /^\d+\.\d+\.json$/;

/** Converte `"1.9"` em `{ major: 1, minor: 9 }`. */
export function parseVersion(v: string): Version {
  const [major, minor] = v.split('.').map(Number);
  return { major, minor };
}

/** Converte `{ major: 1, minor: 9 }` em `"1.9"`. */
export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}`;
}

/** Compara duas versões numericamente por `(major, minor)` — nunca por ordenação de string (`1.10` > `1.9`). */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  return va.major - vb.major || va.minor - vb.minor;
}

/** Próxima versão a partir de `current`: `minor` incrementa o minor, `major` incrementa o major e zera o minor. */
export function bumpVersion(current: string, kind: 'major' | 'minor'): Version {
  const { major, minor } = parseVersion(current);
  return kind === 'major' ? { major: major + 1, minor: 0 } : { major, minor: minor + 1 };
}

/**
 * Versões gravadas em `defDir` (ex.: `schemas/<name>/`), ordenadas crescentemente.
 * Arquivo cujo nome não bate com `major.minor.json` é ignorado silenciosamente: um `notes.json`
 * colocado à mão no diretório não pode derrubar `list`/`buildSnapshot` inteiros.
 */
export function listVersionFiles(defDir: string): string[] {
  return listDirectoryNames(defDir, (entry) => entry.isFile() && VERSION_FILE_RE.test(entry.name))
    .map((file) => path.basename(file, '.json'))
    .sort(compareVersions);
}

/**
 * Definição vigente de `name` dentro de `partDir` (`schemas/`, `vocabulary/<owner>/`, `gates/`):
 * a maior versão do diretório `partDir/name/`, ou o legado `partDir/name.json` como `1.0` se o
 * diretório não tiver nenhuma versão; `null` se nenhum dos dois existir.
 */
export function resolveCurrentDefinition(
  partDir: string,
  name: string,
): { version: string; content: Record<string, unknown> } | null {
  const defDir = path.join(partDir, name);
  const versions = listVersionFiles(defDir);
  if (!isEmpty(versions)) {
    const version = versions[versions.length - 1];
    return {
      version,
      content: readJson(path.join(defDir, `${version}.json`)) as Record<string, unknown>,
    };
  }

  const legacy = readJson(path.join(partDir, `${name}.json`));
  return isNil(legacy) ? null : { version: '1.0', content: legacy as Record<string, unknown> };
}

/** Todas as versões de `name` em `partDir`, do legado (`1.0`, se existir) até a mais nova do diretório. */
export function listVersions(partDir: string, name: string): string[] {
  const legacyExists = !isNil(readJson(path.join(partDir, `${name}.json`)));
  const dirVersions = listVersionFiles(path.join(partDir, name));
  return legacyExists ? ['1.0', ...dirVersions] : dirVersions;
}

/** Nomes de processo válidos de um projeto: diretórios não reservados com `process.json` legível. */
function listValidProcesses(projectDir: string): string[] {
  return listDirectoryNames(
    projectDir,
    (entry) =>
      entry.isDirectory() && !(RESERVED_PROCESS_NAMES as readonly string[]).includes(entry.name),
  ).filter((name) => !isNil(readJson(path.join(projectDir, name, 'process.json'))));
}

/** Projetos existentes e seus processos válidos. */
export function listProjects(dir: string): { name: string; processes: string[] }[] {
  return listDirectoryNames(dir, (entry) => entry.isDirectory()).map((name) => ({
    name,
    processes: listValidProcesses(resolveSafePath(dir, name)),
  }));
}

/** Uma definição do projeto (tipo, vocabulário ou gate) com a vigente e o histórico completo de versões. */
type DefinitionSummary = { name: string; hash: string; version: string; versions: string[] };

/** Detalhe de um projeto: processos, tipos, vocabulário e gates registrados. */
export function readProject(
  dir: string,
  project: string,
): {
  name: string;
  processes: { name: string; createdAt: string }[];
  types: DefinitionSummary[];
  vocabulary: (Omit<DefinitionSummary, 'name'> & { owner: string })[];
  gates: DefinitionSummary[];
} {
  const projectDir = resolveSafePath(dir, project);
  if (!fs.existsSync(projectDir)) {
    throw new HexlogError('PROJECT_NOT_FOUND', `project '${project}' not found`);
  }

  const processes = listValidProcesses(projectDir).map((name) => {
    const manifest = readJson(path.join(projectDir, name, 'process.json')) as ProcessManifest;
    return { name, createdAt: manifest.createdAt };
  });

  const summarize = (partDir: string): DefinitionSummary[] =>
    listDefinitions(partDir).map((d) => ({
      name: d.name,
      hash: d.content.hash as string,
      version: d.version,
      versions: listVersions(partDir, d.name),
    }));

  return {
    name: project,
    processes,
    types: summarize(path.join(projectDir, 'schemas')),
    vocabulary: summarize(path.join(projectDir, 'vocabulary')).map(({ name, ...rest }) => ({
      owner: name,
      ...rest,
    })),
    gates: summarize(path.join(projectDir, 'gates')),
  };
}
