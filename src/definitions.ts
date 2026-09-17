import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import canonicalize from 'canonicalize';
import { isNil, pick } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { z } from 'zod';
import { anchor, sha256hex } from './chain.ts';
import {
  resolveSafePath,
  ioError,
  writeJsonAtomic,
  BUILTIN_GATE_NAMES,
  readJson,
  RESERVED_PROCESS_NAMES,
  RESERVED_TYPE_NAMES,
} from './storage.ts';
import { HexlogError } from './errors.ts';
import type { Vocab, Vocabulary } from './state.ts';

// Reexportados de state.ts (fonte única do schema de vocabulário, DE-29).
export type { Vocab, Vocabulary };

/** Teto de caracteres canônicos (JCS) para um schema custom (§4.10). */
const SCHEMA_MAX_CHARS = 16_000;

/** Logger opcional injetável no Ajv (§4.10): por padrão, nenhum log vai para stdout/stderr. */
export type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/** Resposta comum de `register_*`: o que foi gravado e se substituiu uma versão anterior. */
export type Registered = { project: string; name: string; hash: string; replaced: boolean };

/** Manifesto fixado de um processo (`process.json`, §4.1). */
export type ProcessManifest = {
  project: string;
  process: string;
  createdAt: string;
  fixed: {
    types: Record<string, object>;
    vocabulary: Vocabulary;
    gates: Record<string, { criteria: string }>;
  };
  // `vocabulario` (não `vocabulary`): chave do resumo de hashes ainda espelha o `Hashes` de
  // `mcp.ts` (Fase 4) via a tool `listar`; renomear só aqui quebraria essa validação Zod em runtime.
  hashes: { schemas: string; vocabulario: string; gates: string };
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

/** §4.10: registra um schema JSON custom para `name`, gravando `schemas/<name>.json`. */
export function registerType(
  dir: string,
  project: string,
  name: string,
  schema: Record<string, unknown>,
  options: { log?: Logger } = {},
): Registered {
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

  const file = resolveSafePath(dir, project, 'schemas', `${name}.json`);
  const hash = sha256hex(canonicalSchema);
  const replaced = !isNil(readJson(file));
  writeJsonAtomic(file, { name, schema, hash, registeredAt: new Date().toISOString() });
  return { project, name, hash, replaced };
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

/** §4.9: registra o vocabulário de `owner` (`"core"` ou uma extensão), gravando `vocabulary/<owner>.json`. */
export function registerVocabulary(
  dir: string,
  project: string,
  owner: string,
  vocab: Vocab,
): { project: string; owner: string; hash: string; replaced: boolean } {
  const file = resolveSafePath(dir, project, 'vocabulary', `${owner}.json`);
  const hash = sha256hex(canonicalize(vocab) ?? '');
  const replaced = !isNil(readJson(file));
  writeJsonAtomic(file, { owner, ...vocab, hash, registeredAt: new Date().toISOString() });
  return { project, owner, hash, replaced };
}

/** §4.11: registra o critério de um gate custom, gravando `gates/<name>.json`. */
export function registerGate(
  dir: string,
  project: string,
  name: string,
  criteria: string,
): Registered {
  if ((BUILTIN_GATE_NAMES as readonly string[]).includes(name)) {
    throw new HexlogError('RESERVED_NAME', `gate '${name}' is builtin`);
  }

  const file = resolveSafePath(dir, project, 'gates', `${name}.json`);
  const hash = sha256hex(canonicalize(criteria) ?? '');
  const replaced = !isNil(readJson(file));
  writeJsonAtomic(file, { name, criteria, hash, registeredAt: new Date().toISOString() });
  return { project, name, hash, replaced };
}

/** §4.1: fixa o snapshot atual de definições do projeto num novo `process.json`, criado exclusivamente. */
export function createProcess(
  dir: string,
  project: string,
  process: string,
  clock: () => Date,
): {
  project: string;
  process: string;
  createdAt: string;
  hashes: ProcessManifest['hashes'];
  types: string[];
  owners: string[];
  gates: string[];
} {
  if ((RESERVED_PROCESS_NAMES as readonly string[]).includes(process)) {
    throw new HexlogError('RESERVED_NAME', `process '${process}' is reserved`);
  }

  const projectDir = resolveSafePath(dir, project);
  const fixed = buildSnapshot(projectDir);
  const hashes: ProcessManifest['hashes'] = {
    schemas: sha256hex(canonicalize(fixed.types) ?? ''),
    vocabulario: sha256hex(canonicalize(fixed.vocabulary) ?? ''),
    gates: sha256hex(canonicalize(fixed.gates) ?? ''),
  };
  const createdAt = clock().toISOString();
  const manifest: ProcessManifest = { project, process, createdAt, fixed, hashes };

  createExclusiveFile(resolveSafePath(projectDir, process), manifest, process);

  return {
    project,
    process,
    createdAt,
    hashes,
    types: Object.keys(fixed.types),
    owners: Object.keys(fixed.vocabulary.byOwner),
    gates: Object.keys(fixed.gates),
  };
}

function buildSnapshot(projectDir: string): ProcessManifest['fixed'] {
  const types = Object.fromEntries(
    listDefinitions(path.join(projectDir, 'schemas')).map((d) => [
      d.name,
      d.content.schema as object,
    ]),
  );

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

  const gates = Object.fromEntries(
    listDefinitions(path.join(projectDir, 'gates')).map((d) => [
      d.name,
      { criteria: d.content.criteria as string },
    ]),
  );

  return { types, vocabulary, gates };
}

function extractVocab(content: Record<string, unknown>): Vocab {
  return pick(content, ['milestoneType', 'result', 'action']) as Vocab;
}

/** §4.1.1: criação exclusiva de `process.json` via `linkSync` — vence quem chega primeiro. */
function createExclusiveFile(processDir: string, manifest: ProcessManifest, process: string): void {
  fs.mkdirSync(processDir, { recursive: true, mode: 0o700 });
  const file = path.join(processDir, 'process.json');
  const tmp = path.join(
    processDir,
    `.process.json.${globalThis.process.pid}.${randomBytes(4).toString('hex')}`,
  );

  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(manifest, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.linkSync(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HexlogError('PROCESS_ALREADY_EXISTS', `process '${process}' already exists`);
    }
    throw ioError(e);
  } finally {
    fs.unlinkSync(tmp);
  }
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

  const customSchemas = Object.fromEntries(
    Object.entries(manifest.fixed.types).map(([name, schema]) => [
      name,
      z.fromJSONSchema(schema as z.core.JSONSchema.JSONSchema),
    ]),
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
    { hash: 'vocabulario', fixed: manifest.fixed.vocabulary },
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

type DefinitionFile = { name: string; content: Record<string, unknown> };

/** Lê todo `.json` (não `.`-prefixado) de `partDir`, ou `[]` se o diretório não existe. */
function listDefinitions(partDir: string): DefinitionFile[] {
  return listDirectoryNames(partDir, (entry) => entry.isFile() && entry.name.endsWith('.json')).map(
    (file) => ({
      name: path.basename(file, '.json'),
      content: readJson(path.join(partDir, file)) as Record<string, unknown>,
    }),
  );
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

/** Detalhe de um projeto: processos, tipos, vocabulário e gates registrados. */
export function readProject(
  dir: string,
  project: string,
): {
  name: string;
  processes: { name: string; createdAt: string }[];
  types: { name: string; hash: string }[];
  vocabulary: { owner: string; hash: string }[];
  gates: { name: string; hash: string }[];
} {
  const projectDir = resolveSafePath(dir, project);
  if (!fs.existsSync(projectDir)) {
    throw new HexlogError('PROJECT_NOT_FOUND', `project '${project}' not found`);
  }

  const processes = listValidProcesses(projectDir).map((name) => {
    const manifest = readJson(path.join(projectDir, name, 'process.json')) as ProcessManifest;
    return { name, createdAt: manifest.createdAt };
  });

  const namesAndHashes = (partDir: string) =>
    listDefinitions(partDir).map((d) => ({ name: d.name, hash: d.content.hash as string }));

  return {
    name: project,
    processes,
    types: namesAndHashes(path.join(projectDir, 'schemas')),
    vocabulary: namesAndHashes(path.join(projectDir, 'vocabulary')).map(({ name, hash }) => ({
      owner: name,
      hash,
    })),
    gates: namesAndHashes(path.join(projectDir, 'gates')),
  };
}
