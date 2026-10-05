import type { Hash, Name, RecordId } from './domain/ids.ts';
import type { Gate, RecordType, RelationName } from './domain/definitions.ts';
import type { Manifest } from './domain/manifest.ts';
import type { HexRecord } from './domain/record.ts';
import type { Detail } from './errors.ts';

export type { Manifest };

/** Processo = par projeto/nome; o id de um registro carrega só o processo (D-01). */
export type ProcessRef = { project: Name; process: Name };

/** Processo como está no disco: o manifesto e os bytes do log, sem interpretar linha nenhuma. */
export type RawProcess = {
  manifest: Manifest;
  text: string;
  /** Arquivo vazio conta como terminado, como o de um processo recém-criado. */
  endsWithNewline: boolean;
};

/**
 * O que `decide` devolve a `ProcessStore.write`: `line` já enquadrada por
 * `shared/loader.ts#formatLine` (o adaptador só acrescenta o `\n` de prefixo, se precisar), ou
 * ausente quando não há nada a gravar (replay, D-06); `result` é a resposta de `write`.
 */
export type Decision<T> = { line?: string; result: T };

/**
 * D-25: toda operação é síncrona, exceto `ProcessStore.write`, que é `async` só porque a espera do
 * lock dorme com `setTimeout`. Toda regra de negócio fica em `decide`; o adaptador só sabe de bytes, lock e
 * prefixo `\n`.
 *
 * Erros comuns às quatro portas de armazenamento: falha de disco sai como `IO_ERROR`
 * (`adapters/fs/io.ts#toHexlogError`), com o errno em minúsculas em `details[0].code`; nome inválido
 * (projeto, processo, definição) sai como `INVALID_INPUT` com `invalid-name`. Os `details[].path`
 * (`/project`, `/process`, `/name`, `/version`, `/hash`, `/path`, `/text`) apontam o campo da tool
 * que o adaptador presume; quando o valor veio do manifesto ou de `records[i].type`, o serviço
 * remapeia o `path`.
 */
export type ProcessReader = {
  /**
   * `PROCESS_NOT_FOUND` se não existe; `PROCESS_CORRUPTED` (`unreadable-manifest`) se o manifesto não
   * lê; `PROCESS_TOO_LARGE` (`too-large`) se o `records.jsonl` passa de `MAX_LOG_BYTES`, conferido
   * com `stat` antes de ler.
   */
  read(ref: ProcessRef): RawProcess;
  /**
   * Só o `process.json`, sem tocar o `records.jsonl` (nem o teto de `MAX_LOG_BYTES`): para quem só
   * precisa do manifesto. `PROCESS_NOT_FOUND` e `PROCESS_CORRUPTED` (`unreadable-manifest`) como em
   * `read`.
   */
  readManifest(ref: ProcessRef): Manifest;
  /** Nomes dos processos do projeto, em ordem de unidade de código (a do `sort` padrão). */
  list(project: Name): Name[];
  /** Nomes dos projetos, na mesma ordem de `list`. */
  listProjects(): Name[];
};

/** Lado de escrita de `ProcessReader`; a consulta (`queries/`) só enxerga o lado de leitura. */
export type ProcessStore = ProcessReader & {
  /**
   * `false` quando o processo já existe: o manifesto existente nunca é tocado. `RESERVED_NAME`
   * (`reserved-name`) para nome reservado de processo; `INTERNAL` se o manifesto gravado não bate
   * com `ref`.
   */
  create(ref: ProcessRef, manifest: Manifest): boolean;
  /**
   * Adquire o lock, lê o processo cru e chama `decide`, que é síncrona e pode lançar `HexlogError`;
   * grava `line` (se houver), faz fsync, solta o lock e devolve `result`. O erro lançado por
   * `decide` sai intacto. `PROCESS_NOT_FOUND` se o processo não existe; `PROCESS_TOO_LARGE` se
   * `line` faria o arquivo passar de `MAX_LOG_BYTES` (o lote é recusado sem gravar e o processo
   * continua legível). Se o `release` falha depois do `fsync`, a linha já é durável e mesmo assim
   * `write` lança `IO_ERROR`: reenviar com a mesma `key` vira `replayed` (D-06) e sem `key` duplica o
   * lote. Se `decide` ou a gravação já falharam, o erro delas sai inalterado e a falha do
   * `release` vai só ao log (`release-failed`).
   */
  write<T>(ref: ProcessRef, decide: (raw: RawProcess) => Decision<T>): Promise<T>;
};

export type DefinitionKind = 'types' | 'relations' | 'gates';

/** Definição guardada por pasta (`types/`, `relations/`, `gates/`). */
export type DefinitionOf = { types: RecordType; relations: RelationName; gates: Gate };

/** Leitura que a consulta (`queries/`) faz das definições: só as listagens de `list`. */
export type DefinitionReader = {
  /** Lista as pastas de nome, inclusive a que ficou sem nenhuma versão (falha no meio de `write`). */
  names(project: Name, kind: DefinitionKind): Name[];
  /** Em ordem numérica crescente (`domain/definitions.ts#compareVersions`); nome sem pasta devolve `[]`. */
  versions(project: Name, kind: DefinitionKind, name: Name): string[];
};

/** Versões imutáveis `<major>.<minor>` de tipos, nomes de relação e gates de um projeto. */
export type DefinitionStore = DefinitionReader & {
  /**
   * `TYPE_NOT_FOUND`, `RELATION_NOT_FOUND` ou `GATE_NOT_FOUND` conforme o `kind`: `unknown-name`
   * (`/name`) se o nome não tem nenhuma versão; `unknown-version` (`/version`, com `versions`, nunca
   * vazia) se o nome existe e a versão pedida não. `INVALID_INPUT` (`invalid-version`) se a versão não
   * é `<major>.<minor>` canônica. `INTERNAL` (`unreadable-definition`) se o arquivo não é JSON ou não
   * passa no schema de domínio do `kind`.
   */
  read<K extends DefinitionKind>(
    project: Name,
    kind: K,
    name: Name,
    version: string,
  ): DefinitionOf[K];
  /**
   * `false` quando a versão já existe: uma versão gravada nunca é sobrescrita. O `false` não
   * distingue replay (a mesma definição) de conflito (outra): quem chama relê com `versions` e
   * `read` e compara. `INVALID_INPUT` (`invalid-version`) se a versão não é `<major>.<minor>`
   * canônica. Valida a definição contra o schema de domínio do `kind` antes de gravar e lança
   * `INTERNAL` (`invalid-definition`, `path` `/definition`, sem o conteúdo) se não passar, para não
   * gravar uma versão que o próprio `read` recusaria.
   */
  write<K extends DefinitionKind>(
    project: Name,
    kind: K,
    name: Name,
    version: string,
    definition: DefinitionOf[K],
  ): boolean;
};

export type AttachmentStatus = 'ok' | 'missing' | 'corrupted';

/**
 * Resultado de gravar um anexo: `deduplicated` é `true` quando o blob com esse hash já existia e foi
 * só conferido, nunca sobrescrito. A saída de `attach` o repassa.
 */
export type AttachmentPut = { hash: Hash; bytes: number; deduplicated: boolean };

/**
 * Leitura de blobs imutáveis endereçados pelo sha256 dos bytes UTF-8, em
 * `<projeto>/attachments/<sha256>`. `invalid-hash` e `invalid-name` (`INVALID_INPUT`) valem para
 * `status` e `read`.
 */
export type AttachmentReader = {
  /** Devolve `'corrupted'` em vez de lançar; só `invalid-hash`, `invalid-name` e `IO_ERROR` lançam. */
  status(project: Name, hash: Hash): AttachmentStatus;
  /**
   * `ATTACHMENT_NOT_FOUND` ou `ATTACHMENT_CORRUPTED`; `INVALID_INPUT` (`invalid-hash`,
   * `invalid-name`). A paginação é do serviço.
   */
  read(project: Name, hash: Hash): string;
};

/**
 * Lado de escrita de `AttachmentReader`: grava blobs, nunca sobrescreve.
 * D-15: `putPath` só lê arquivo dentro da raiz configurada na construção do adaptador e fora do
 * `dataDir`; as regras de extensão e de "exatamente um de `text`/`path`", além de texto vazio e
 * surrogate solto em `putText`, são do serviço (`commands/attachment.ts`, F4).
 * D-25: operação síncrona, como as demais portas (só `ProcessStore.write` é `async`).
 * `invalid-name` (`INVALID_INPUT`) vale para as quatro operações; `invalid-hash`, só para `status` e
 * `read`.
 */
export type AttachmentStore = AttachmentReader & {
  /**
   * `INVALID_INPUT` com `too-big` (`/text`) acima de 1 MiB. `ATTACHMENT_CORRUPTED` se o blob com esse
   * hash já existe e não confere (nunca é reparado nem sobrescrito).
   */
  putText(project: Name, text: string): AttachmentPut;
  /**
   * `INVALID_INPUT` com `details[0].code` `outside-allowed-root`, `inside-data-dir`, `not-found`,
   * `not-regular` (symlink, não arquivo regular ou mais de um link), `too-big` (`/path`), `bad-args`
   * (arquivo vazio) ou `invalid-utf8`; a ordem das recusas é fixa e só a primeira sai.
   * `ATTACHMENT_CORRUPTED` se o blob com esse hash já existe e não confere (nunca é reparado nem
   * sobrescrito).
   */
  putPath(project: Name, path: string): AttachmentPut;
};

/**
 * JSON Schema: `Detail[]` vazio = aprovado. `checkSchema` devolve no máximo 50 detalhes, sem repetição
 * de path+code+message; quando corta, acrescenta como último um `Detail` com `code`
 * `too-many-errors` e a quantidade omitida na `message` (`errors.ts#capDetails`). Os
 * omitidos não são recuperáveis: o validador não guarda estado, então o chamador não trunca de novo.
 */
export type Validator = {
  /**
   * Todo `path` é relativo ao documento do schema, e o serviço prefixa `/schema`. Os erros do
   * metaschema saem com o ponto do schema; os de compilação (palavra-chave ou formato desconhecido,
   * `$ref` sem destino, `$schema` de outro rascunho, `$id` de metaschema, `$async: true`) saem como
   * um só `Detail` com `path` vazio (a raiz) e `code` `invalid-schema`. Também recusa regex que
   * pode explodir em tempo (ReDoS):
   * `pattern` ou chave de `patternProperties` reprovados pela `safe-regex2`, e `pattern` sem
   * `maxLength` de até 256 no mesmo subschema; saem com `path` do campo (relativo ao schema) e
   * `code` `invalid-schema`. Devolve todos os erros do schema. Limite conhecido: a `safe-regex2` é
   * heurística, e alternância sobreposta como `(a|aa)+` passa (risco aceito em 2026-10-02). A
   * `safe-regex2` também recusa regex linear com grupo repetido (falso positivo, ex.: kebab-case);
   * ver `adapters/validator.ts#createValidator`. Outro limite, aceito: o percurso não segue
   * `$ref`, então `$ref` com ponteiro para `const`/`default`/`enum`/`examples` esconde `pattern` da
   * `safe-regex2` e do teto de `maxLength` (`adapters/validator.ts#createValidator`).
   */
  checkSchema(schema: RecordType): Detail[];
  /**
   * Pressupõe um schema que já passou em `checkSchema`: com schema que não compila lança `Error` cru
   * (vira `INTERNAL` na borda, `mcp/kernel.ts#execute`). O `path` dos detalhes é relativo a `data`.
   * Devolve um erro por subschema avaliado, não um por campo (em `anyOf`/`oneOf`/`propertyNames`
   * saem os dos ramos). O `maxLength` é avaliado antes do `pattern` e o ajv para aí em cada
   * ramo, então o regex nunca roda sobre string acima do teto. Isso não cobre
   * a chave de `patternProperties` (nomes de propriedade não têm teto); ali só vale a `safe-regex2`.
   */
  validate(schema: RecordType, data: HexRecord['data']): Detail[];
};

/** Chave do índice de busca do alcance projeto; não é um `Name`, então nunca colide com processo. */
export const PROJECT_INDEX = '*';

/**
 * Índice de texto sobre os registros já carregados; devolve ids por relevância. O `process` é a
 * chave do cache. `records` pode ser o log inteiro do processo, o prefixo cortado pelo marcador
 * (cursor e `changesSince`) ou a lista mesclada do projeto sob um `ProcessRef` com
 * `process: PROJECT_INDEX` (`queries/select.ts#select`). `allowed`, quando passado, restringe o
 * resultado a esses ids e também decide o fallback `OR`: o conjunto devolvido é o dos registros
 * permitidos que casam (`adapters/search.ts#createSearchIndex`).
 *
 * Invariantes do chamador: `PROJECT_INDEX` (`'*'`) não é um `Name` e só compila porque `Name` é
 * `string`; `records` vêm de leitura de cadeia verificada (`queries/read.ts#readScope`); e as
 * listas sucessivas de um mesmo processo são prefixos do mesmo log append-only, que é o que torna
 * a contagem mais a impressão do último registro uma chave de validade correta. A impressão é o
 * `JSON.stringify` do registro (`adapters/search.ts#fingerprintOf`), não o JCS da cadeia.
 */
export type SearchIndex = {
  search(
    process: ProcessRef,
    records: readonly HexRecord[],
    text: string,
    allowed?: ReadonlySet<RecordId>,
  ): RecordId[];
  /**
   * Termos pesquisáveis de `text`, pelo mesmo tokenizador de `search` (distintos, sem acento, em
   * minúsculas). Vazio quando `text` não tem nenhum (só espaço ou pontuação): `search` não casaria
   * nada, e quem consulta recusa em vez de devolver `[]`.
   */
  terms(text: string): string[];
};
