import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import canonicalize from 'canonicalize';
import { isNil, pick } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import { z } from 'zod';
import { ancora, sha256hex } from './cadeia.ts';
import {
  caminho,
  erroIo,
  escreverJsonAtomico,
  GATES_EMBUTIDOS_NOMES,
  lerJson,
  PROCESSOS_RESERVADOS,
  TIPOS_RESERVADOS,
} from './dados.ts';
import { ErroHexlog } from './erros.ts';
import type { Vocab, Vocabulario } from './estado.ts';

// Reexportados de estado.ts (fonte única do schema de vocabulário, DE-29).
export type { Vocab, Vocabulario };

/** Teto de caracteres canônicos (JCS) para um schema custom (§4.10). */
const TETO_SCHEMA_CHARS = 16_000;

/** Logger opcional injetável no Ajv (§4.10): por padrão, nenhum log vai para stdout/stderr. */
export type Logger = { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

/** Resposta comum de `registrar_*`: o que foi gravado e se substituiu uma versão anterior. */
export type Definida = { projeto: string; nome: string; hash: string; substituiu: boolean };

/** Manifesto fixado de um processo (`processo.json`, §4.1). */
export type Manifesto = {
  projeto: string;
  processo: string;
  criadoEm: string;
  fixado: {
    tipos: Record<string, object>;
    vocabulario: Vocabulario;
    gates: Record<string, { criterio: string }>;
  };
  hashes: { schemas: string; vocabulario: string; gates: string };
};

/** Processo carregado e pronto para uso: manifesto verificado, âncora e schemas Zod dos tipos custom. */
export type ProcessoCarregado = {
  manifesto: Manifesto;
  ancora: string;
  esquemasCustom: Record<string, z.ZodType>;
  dirProcesso: string;
  arquivoEventos: string;
};

const VOCAB_VAZIO: Vocab = { marcoTipo: [], resultado: [], acao: [] };

/** §4.10: registra um schema JSON custom para `nome`, gravando `schemas/<nome>.json`. */
export function registrarTipo(
  dir: string,
  projeto: string,
  nome: string,
  schema: Record<string, unknown>,
  opcoes: { log?: Logger } = {},
): Definida {
  if ((TIPOS_RESERVADOS as readonly string[]).includes(nome)) {
    throw new ErroHexlog('NOME_RESERVADO', `tipo '${nome}' é reservado`);
  }

  const schemaCanonico = canonicalize(schema) ?? '';
  if (schemaCanonico.length > TETO_SCHEMA_CHARS) {
    throw new ErroHexlog('SCHEMA_INVALIDO', `schema excede ${TETO_SCHEMA_CHARS} caracteres canônicos`, [
      { caminho: '/schema', codigo: 'too_big', mensagem: `tamanho canônico ${schemaCanonico.length}` },
    ]);
  }

  validarComAjv(schema, opcoes.log);

  if (schema.type !== 'object') {
    throw new ErroHexlog('SCHEMA_INVALIDO', 'raiz do schema precisa ser "type": "object"', [
      { caminho: '/schema/type', codigo: 'invalid_type', mensagem: 'esperado "object"' },
    ]);
  }

  try {
    z.fromJSONSchema(schema);
  } catch {
    // a mensagem bruta do zod não é exposta (§4.10): só o código de domínio.
    throw new ErroHexlog('SCHEMA_INVALIDO', 'construção do schema não suportada', [
      { caminho: '/schema', codigo: 'nao-suportado', mensagem: 'construção de schema não suportada' },
    ]);
  }

  const arquivo = caminho(dir, projeto, 'schemas', `${nome}.json`);
  const hash = sha256hex(schemaCanonico);
  const substituiu = !isNil(lerJson(arquivo));
  escreverJsonAtomico(arquivo, { nome, schema, hash, registradoEm: new Date().toISOString() });
  return { projeto, nome, hash, substituiu };
}

/** Ajv2020 strict + ajv-formats: pega typo de keyword, forma malformada e `$ref` externo. */
function validarComAjv(schema: Record<string, unknown>, log: Logger | undefined): void {
  try {
    const ajv = new Ajv2020.default({ strict: true, allErrors: true, logger: log ?? false });
    addFormats.default(ajv);
    ajv.compile(schema);
  } catch (e) {
    const instancePath = (e as { instancePath?: string }).instancePath;
    const caminhoErro = isNil(instancePath) ? '/schema' : `/schema${instancePath}`;
    throw new ErroHexlog('SCHEMA_INVALIDO', 'schema reprovado pelo Ajv', [
      { caminho: caminhoErro, codigo: 'ajv_invalido', mensagem: (e as Error).message },
    ]);
  }
}

/** §4.9: registra o vocabulário de `dono` (`"nucleo"` ou uma extensão), gravando `vocabulario/<dono>.json`. */
export function registrarVocabulario(
  dir: string,
  projeto: string,
  dono: string,
  vocab: Vocab,
): { projeto: string; dono: string; hash: string; substituiu: boolean } {
  const arquivo = caminho(dir, projeto, 'vocabulario', `${dono}.json`);
  const hash = sha256hex(canonicalize(vocab) ?? '');
  const substituiu = !isNil(lerJson(arquivo));
  escreverJsonAtomico(arquivo, { dono, ...vocab, hash, registradoEm: new Date().toISOString() });
  return { projeto, dono, hash, substituiu };
}

/** §4.11: registra o critério de um gate custom, gravando `gates/<nome>.json`. */
export function registrarGate(dir: string, projeto: string, nome: string, criterio: string): Definida {
  if ((GATES_EMBUTIDOS_NOMES as readonly string[]).includes(nome)) {
    throw new ErroHexlog('NOME_RESERVADO', `gate '${nome}' é embutido`);
  }

  const arquivo = caminho(dir, projeto, 'gates', `${nome}.json`);
  const hash = sha256hex(canonicalize(criterio) ?? '');
  const substituiu = !isNil(lerJson(arquivo));
  escreverJsonAtomico(arquivo, { nome, criterio, hash, registradoEm: new Date().toISOString() });
  return { projeto, nome, hash, substituiu };
}

/** §4.1: fixa o snapshot atual de definições do projeto num novo `processo.json`, criado exclusivamente. */
export function criarProcesso(
  dir: string,
  projeto: string,
  processo: string,
  relogio: () => Date,
): {
  projeto: string;
  processo: string;
  criadoEm: string;
  hashes: Manifesto['hashes'];
  tipos: string[];
  donos: string[];
  gates: string[];
} {
  if ((PROCESSOS_RESERVADOS as readonly string[]).includes(processo)) {
    throw new ErroHexlog('NOME_RESERVADO', `processo '${processo}' é reservado`);
  }

  const dirProjeto = caminho(dir, projeto);
  const fixado = montarSnapshot(dirProjeto);
  const hashes: Manifesto['hashes'] = {
    schemas: sha256hex(canonicalize(fixado.tipos) ?? ''),
    vocabulario: sha256hex(canonicalize(fixado.vocabulario) ?? ''),
    gates: sha256hex(canonicalize(fixado.gates) ?? ''),
  };
  const criadoEm = relogio().toISOString();
  const manifesto: Manifesto = { projeto, processo, criadoEm, fixado, hashes };

  criarArquivoExclusivo(caminho(dirProjeto, processo), manifesto, processo);

  return {
    projeto,
    processo,
    criadoEm,
    hashes,
    tipos: Object.keys(fixado.tipos),
    donos: Object.keys(fixado.vocabulario.porDono),
    gates: Object.keys(fixado.gates),
  };
}

function montarSnapshot(dirProjeto: string): Manifesto['fixado'] {
  const tipos = Object.fromEntries(
    listarDefinicoes(path.join(dirProjeto, 'schemas')).map((d) => [d.nome, d.conteudo.schema as object]),
  );

  const arquivosVocab = listarDefinicoes(path.join(dirProjeto, 'vocabulario'));
  if (isEmpty(arquivosVocab)) {
    throw new ErroHexlog('VOCABULARIO_AUSENTE', 'nenhum vocabulário registrado no projeto');
  }
  const nucleoArquivo = arquivosVocab.find((d) => d.nome === 'nucleo');
  const vocabulario: Vocabulario = {
    nucleo: isNil(nucleoArquivo) ? VOCAB_VAZIO : extrairVocab(nucleoArquivo.conteudo),
    porDono: Object.fromEntries(
      arquivosVocab.filter((d) => d.nome !== 'nucleo').map((d) => [d.nome, extrairVocab(d.conteudo)]),
    ),
  };

  const gates = Object.fromEntries(
    listarDefinicoes(path.join(dirProjeto, 'gates')).map((d) => [d.nome, { criterio: d.conteudo.criterio as string }]),
  );

  return { tipos, vocabulario, gates };
}

function extrairVocab(conteudo: Record<string, unknown>): Vocab {
  return pick(conteudo, ['marcoTipo', 'resultado', 'acao']) as Vocab;
}

/** §4.1.1: criação exclusiva de `processo.json` via `linkSync` — vence quem chega primeiro. */
function criarArquivoExclusivo(dirProcesso: string, manifesto: Manifesto, processo: string): void {
  fs.mkdirSync(dirProcesso, { recursive: true, mode: 0o700 });
  const arquivo = path.join(dirProcesso, 'processo.json');
  const tmp = path.join(dirProcesso, `.processo.json.${process.pid}.${randomBytes(4).toString('hex')}`);

  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(manifesto, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.linkSync(tmp, arquivo);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ErroHexlog('PROCESSO_JA_EXISTE', `processo '${processo}' já existe`);
    }
    throw erroIo(e);
  } finally {
    fs.unlinkSync(tmp);
  }
}

/** Carrega e verifica um processo: hashes internos recalculados, âncora e schemas Zod dos tipos custom. */
export function carregarProcesso(dir: string, projeto: string, processo: string): ProcessoCarregado {
  const dirProcesso = caminho(dir, projeto, processo);
  const arquivo = path.join(dirProcesso, 'processo.json');

  let manifestoLido: unknown;
  try {
    manifestoLido = lerJson(arquivo);
  } catch {
    throw new ErroHexlog('PROCESSO_CORROMPIDO', 'processo.json ilegível', [
      { caminho: '', codigo: 'ilegivel', mensagem: 'processo.json não pôde ser lido' },
    ]);
  }
  if (isNil(manifestoLido)) {
    throw new ErroHexlog('PROCESSO_INEXISTENTE', `processo '${processo}' não encontrado`);
  }

  const manifesto = manifestoLido as Manifesto;
  verificarHashes(manifesto);

  const esquemasCustom = Object.fromEntries(
    Object.entries(manifesto.fixado.tipos).map(([nome, schema]) => [
      nome,
      z.fromJSONSchema(schema as z.core.JSONSchema.JSONSchema),
    ]),
  );

  return {
    manifesto,
    ancora: ancora(manifesto),
    esquemasCustom,
    dirProcesso,
    arquivoEventos: path.join(dirProcesso, 'eventos.jsonl'),
  };
}

/** Recalcula `hashes.X = sha256(canonicalize(fixado.X))` e compara com o gravado (§4.1). */
function verificarHashes(manifesto: Manifesto): void {
  const partes: { hash: keyof Manifesto['hashes']; fixado: unknown }[] = [
    { hash: 'schemas', fixado: manifesto.fixado.tipos },
    { hash: 'vocabulario', fixado: manifesto.fixado.vocabulario },
    { hash: 'gates', fixado: manifesto.fixado.gates },
  ];

  for (const parte of partes) {
    const recalculado = sha256hex(canonicalize(parte.fixado) ?? '');
    if (recalculado !== manifesto.hashes[parte.hash]) {
      throw new ErroHexlog('PROCESSO_CORROMPIDO', `hash de ${parte.hash} não bate com o snapshot fixado`, [
        { caminho: `/hashes/${parte.hash}`, codigo: 'hash_divergente', mensagem: 'hash recalculado difere do gravado' },
      ]);
    }
  }
}

type ArquivoDefinicao = { nome: string; conteudo: Record<string, unknown> };

/** Lê todo `.json` (não `.`-prefixado) de `dirParte`, ou `[]` se o diretório não existe. */
function listarDefinicoes(dirParte: string): ArquivoDefinicao[] {
  return listarNomesDiretorio(dirParte, (entrada) => entrada.isFile() && entrada.name.endsWith('.json')).map(
    (arquivo) => ({
      nome: path.basename(arquivo, '.json'),
      conteudo: lerJson(path.join(dirParte, arquivo)) as Record<string, unknown>,
    }),
  );
}

/** Lê os nomes de entradas de `dirPai` que casam `filtro`, ignorando `.`-prefixados; `[]` se o diretório não existe. */
function listarNomesDiretorio(dirPai: string, filtro: (entrada: fs.Dirent) => boolean): string[] {
  let entradas: fs.Dirent[];
  try {
    entradas = fs.readdirSync(dirPai, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw erroIo(e);
  }
  return entradas.filter((entrada) => !entrada.name.startsWith('.') && filtro(entrada)).map((entrada) => entrada.name);
}

/** Nomes de processo válidos de um projeto: diretórios não reservados com `processo.json` legível. */
function listarProcessosValidos(dirProjeto: string): string[] {
  return listarNomesDiretorio(
    dirProjeto,
    (entrada) => entrada.isDirectory() && !(PROCESSOS_RESERVADOS as readonly string[]).includes(entrada.name),
  ).filter((nome) => !isNil(lerJson(path.join(dirProjeto, nome, 'processo.json'))));
}

/** Projetos existentes e seus processos válidos. */
export function listarProjetos(dir: string): { nome: string; processos: string[] }[] {
  return listarNomesDiretorio(dir, (entrada) => entrada.isDirectory()).map((nome) => ({
    nome,
    processos: listarProcessosValidos(caminho(dir, nome)),
  }));
}

/** Detalhe de um projeto: processos, tipos, vocabulário e gates registrados. */
export function lerProjeto(
  dir: string,
  projeto: string,
): {
  nome: string;
  processos: { nome: string; criadoEm: string }[];
  tipos: { nome: string; hash: string }[];
  vocabulario: { dono: string; hash: string }[];
  gates: { nome: string; hash: string }[];
} {
  const dirProjeto = caminho(dir, projeto);
  if (!fs.existsSync(dirProjeto)) {
    throw new ErroHexlog('PROJETO_INEXISTENTE', `projeto '${projeto}' não encontrado`);
  }

  const processos = listarProcessosValidos(dirProjeto).map((nome) => {
    const manifesto = lerJson(path.join(dirProjeto, nome, 'processo.json')) as Manifesto;
    return { nome, criadoEm: manifesto.criadoEm };
  });

  const nomesEHashes = (dirParte: string) =>
    listarDefinicoes(dirParte).map((d) => ({ nome: d.nome, hash: d.conteudo.hash as string }));

  return {
    nome: projeto,
    processos,
    tipos: nomesEHashes(path.join(dirProjeto, 'schemas')),
    vocabulario: nomesEHashes(path.join(dirProjeto, 'vocabulario')).map(({ nome, hash }) => ({ dono: nome, hash })),
    gates: nomesEHashes(path.join(dirProjeto, 'gates')),
  };
}
