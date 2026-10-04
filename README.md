# hexlog

Servidor MCP stdio para agentes registrarem seu próprio histórico de trabalho:
registros tipados, relações entre eles e gates declarativos, num log append-only
com cadeia de hash por processo. Expõe exatamente 11 tools. Não tem CLI nem
daemon: só o servidor MCP e um hook de isolamento instalados no Claude Code. Os
scripts de `scripts/` (`export`, `timeline`, `insights`) são de leitura, rodados à
mão.

Os dados ficam em `<D>`, que é `$XDG_DATA_HOME/hexlog/` (ou `~/.local/share/hexlog`
se a variável estiver ausente, vazia ou não for um caminho absoluto). `<D>` precisa de um
sistema de arquivos com hard link e semântica POSIX (`rename` e `link` atômicos). O dado da
1.0 mora só em `<D>/.v1/`: um diretório por projeto e, dentro dele, um log JSONL
por processo. Cada linha do log referencia o hash da anterior, então qualquer
alteração ou remoção de linha quebra a cadeia de forma detectável pela tool
`verify_chain`.

As decisões de projeto estão nos ADRs: o domínio no [ADR 0007](docs/adr-0007-dominio.md),
os serviços no [ADR 0008](docs/adr-0008-servicos.md) e o ferramental (tools, lock,
scripts, arquivamento) no [ADR 0009](docs/adr-0009-ferramental.md).

## Requisitos

- Linux. O lock por pid, a gravação atômica e o arquivador dependem de `/proc`, de hard link e de
  `fsync` de diretório (`src/adapters/fs/atomic.ts#writeFileAtomic`): macOS não foi testado, e
  Windows, FAT, exFAT e drvfs (`/mnt/c` no WSL) ficam fora.
- Node `>= 24.18.1`.
- Claude Code, com `~/.claude/settings.json` já existente (o instalador grava
  nele; harness não instalado = instalação falha com uma mensagem explícita).

## Instalação e atualização

```sh
npm ci
npm test
node scripts/install.ts
```

O `npm ci` precisa ser completo, sem `--omit=dev`: o instalador usa `esbuild`
e `@modelcontextprotocol/client`, que são dependências de desenvolvimento.

`node scripts/install.ts` faz quatro coisas:

1. Constrói o servidor e o hook com `esbuild` e verifica o artefato preparado
   antes de trocar qualquer coisa (o hook precisa negar o diretório de dados e
   permitir o resto; o servidor precisa subir e anunciar as 11 tools).
2. Copia os dois bundles (servidor, `bash-guard`) para `~/.local/lib/hexlog/<versão>/`,
   fora da working tree e fora do diretório de dados. É essa cópia que as sessões
   executam.
3. Registra as 4 regras de deny e o hook PreToolUse em
   `~/.claude/settings.json` (com backup em `settings.json.bak-hexlog` antes
   de qualquer troca) e registra o servidor MCP em escopo `user`. A regra de deny
   de um `<D>` antigo que o guard remove é impressa (`removed deny rule: <regra>`).
4. Copia cada pasta de `skills/` (hoje `hexlog`, `hexlog-flow` e
   `hexlog-setup`) para `~/.claude/skills/<nome>/`, com troca atômica e sem
   backup.

**Mudar código no repositório não afeta nenhuma sessão em andamento nem novas
sessões até rodar o instalador de novo.** As sessões sempre executam a cópia
de `~/.local/lib/hexlog/<versão>/`, nunca a working tree. Depois de instalar,
reinicie o Claude Code: a lista de tools é cache da sessão.

Rodar o instalador de novo sem nada ter mudado imprime
`version <versão> already installed and intact; nothing to do`, e não toca em
`settings.json` nem no MCP. Argumento desconhecido é recusado com exit 1 antes
de qualquer escrita; os aceitos são `--check` e `--archive-0x`.

### Instalação concorrente

Se dois processos de instalação rodarem ao mesmo tempo, um deles pode
terminar com a mensagem `another installation swapped <versão> at the same
time; run the installer again`. Nesse caso, espere a outra instalação
terminar e rode `node scripts/install.ts` de novo.

### Versões antigas

O instalador nunca apaga versões antigas de `~/.local/lib/hexlog/`. A remoção
é manual, e só deve ser feita para versões **não registradas** em
`settings.json`/`~/.claude.json`, e **só depois de reiniciar todas as sessões
abertas**: uma sessão iniciada antes da troca de versão mantém o servidor
antigo carregado em memória e pode continuar chamando o caminho antigo do
hook mesmo depois de o diretório ser removido.

## Dado 0.x: arquivamento (`--archive-0x`)

A 1.0 não lê nem migra o dado do 0.x: ela só enxerga `<D>/.v1/`. O 0.x grava
projetos direto em `<D>`, e a detecção é positiva: qualquer entrada de `<D>` com
nome de projeto 0.x (minúsculas, dígitos e hífen, exceto `archive`) conta como
dado 0.x. Com dado 0.x em `<D>`, o servidor recusa toda tool com `LEGACY_DATA`
(o `details` traz o comando de arquivamento) e os scripts de leitura saem com 2.

Para arquivar:

```sh
node scripts/install.ts                # lista o que seria arquivado e sai 2, sem alterar nada
node scripts/install.ts --archive-0x   # arquiva e segue para a instalação
node scripts/install.ts --check
```

O `--archive-0x` gera `<D>/archive/hexlog-0x-<data>.tar` com todos os arquivos
regulares do 0.x, relê o pacote e confere caminho e sha256 contra a lista, relê e
re-hasheia os originais e só então remove o que listou (arquivos e depois
diretórios vazios, sem recursão). Qualquer divergência aborta com exit 1, sem
instalar e sem apagar nada que não esteja no `.tar` verificado.

- **Recusas:** servidor 0.x vivo (processo com `server.mjs` de uma versão 0.x em
  `~/.local/lib/hexlog/`), `/proc` ilegível (não dá para confirmar que nenhum
  servidor roda), lock 0.x com dono vivo ou com `holder` fora do formato
  `<pid>-<hex>`, e symlink ou arquivo especial no dado 0.x. Feche as sessões do
  Claude Code antes.
- **Retomada:** se a execução cair depois de gerar o `.tar`, rodar de novo reusa o
  `.tar` mais novo que contém todo arquivo restante com o mesmo sha256, em vez de
  gerar outro.
- **Um ou vários `.tar`:** uma execução com arquivo novo no 0.x gera outro `.tar`
  em vez de reescrever o anterior, então `<D>/archive/` pode ter mais de um. O
  nome tem resolução de segundo: dois arquivamentos no mesmo segundo que precisem
  de pacote novo sobrescrevem o anterior (teto aceito no ADR 0009).
- **Cópia manual antes:** `cp -a ~/.local/share/hexlog ~/hexlog-0x-backup-$(date +%F)`.
  Ensaie primeiro numa cópia (`XDG_DATA_HOME` e `HOME` apontando para um diretório
  temporário), e confira o pacote só pelos arquivos regulares, porque o `tar` pode
  gravar ou não as entradas de diretório.

Depois do arquivamento, a trilha 0.x de todo projeto só existe nos `.tar`.

### Reler a trilha 0.x arquivada

Sem passo novo na instalação: extraia os `.tar` numa pasta descartável e suba um
servidor 0.x só para ela, com o seu `XDG_DATA_HOME`.

```sh
R=$(mktemp -d); mkdir -p "$R/hexlog" "$R/src"
for t in $(ls -tr ~/.local/share/hexlog/archive/hexlog-0x-*.tar); do tar -xf "$t" -C "$R/hexlog"; done
git archive v0.4.0 | tar -x -C "$R/src"        # ou 87237c3 no lugar da tag
(cd "$R/src" && npm ci && node scripts/build.ts --outdir "$R/bin")
```

Aponte um `$R/mcp.json` para o bundle e para a pasta extraída:

```json
{"mcpServers":{"hexlog":{"command":"node","args":["<R>/bin/server.mjs"],"env":{"XDG_DATA_HOME":"<R>"}}}}
```

e rode `claude -p "<pedido>" --mcp-config "$R/mcp.json" --strict-mcp-config`. Os
`.tar` entram do mais velho para o mais novo (o `ls -tr` ordena pela data de
modificação), porque o mais novo sobrescreve o mais velho; `tar -xf a.tar b.tar`
trataria o segundo como nome de membro, por isso o laço. O `<D>` real não é tocado.

### Voltar ao 0.x

Se algo falhar depois do arquivamento:

1. Feche as sessões do Claude Code.
2. Tire o dado 1.0 do caminho, para não se misturar: `mv ~/.local/share/hexlog/.v1 ~/hexlog-1x-aside-$(date +%F)`.
3. Restaure o 0.x, cada `.tar` do mais velho para o mais novo (ou use a cópia manual):
   `for t in $(ls -tr ~/.local/share/hexlog/archive/hexlog-0x-*.tar); do tar -xf "$t" -C ~/.local/share/hexlog; done`.
4. Tire `archive/` do caminho, porque o 0.x o listaria como um projeto vazio:
   `mv ~/.local/share/hexlog/archive ~/hexlog-archive-aside-$(date +%F)`.
5. Reinstale o 0.x: `git checkout v0.4.0 && npm ci && node scripts/install.ts`
   (ou `87237c3` no lugar da tag) e reinicie o Claude Code.

## Verificação (`--check`)

```sh
node scripts/install.ts --check
```

Rode isso depois de: reinstalar o harness do Claude Code, trocar de versão do
Node pelo nvm, mexer manualmente em `~/.local/lib/hexlog/`, ou quando uma
instalação anterior avisou `artifact-outdated`. O `--check` não arquiva e nem
olha `<D>` em busca de dado 0.x.

O `--check` é o único mecanismo que detecta o guard ausente, alterado ou
quebrado. Ele confere, nesta ordem, e cada item pendente aparece como
`missing: <item>`:

| Item | Significa |
|---|---|
| `deny-read-dir` | falta a regra `Read(/<dados>)` em `permissions.deny` |
| `deny-read` | falta a regra `Read(/<dados>/**)` |
| `deny-edit` | falta a regra `Edit(/<dados>/**)` |
| `deny-edit-lib` | falta a regra `Edit(/<home>/.local/lib/hexlog/**)`, que protege o artefato instalado |
| `hook` | não há entrada do hook do hexlog em `hooks.PreToolUse` |
| `node` | o executável do Node referenciado no hook não existe |
| `hook-file` | o `bash-guard.mjs` referenciado no hook não existe em disco |
| `hook-not-denying` | o hook instalado não devolveu exit 2 para um comando que deveria negar |
| `hook-not-allowing` | o hook instalado não devolveu exit 0 para um comando inofensivo |
| `mcp` | `~/.claude.json` não tem `mcpServers.hexlog` apontando pro servidor esperado |
| `artifact-modified` | os bytes de `server.mjs` ou `bash-guard.mjs` instalados divergem do `manifest.json` da própria versão |
| `skill-file:<nome>` | falta `~/.claude/skills/<nome>/SKILL.md` de alguma das skills de `skills/` (um item por skill) |

Qualquer item na lista de faltando encerra o `--check` com exit 1.

`artifact-modified` significa que o artefato instalado foi modificado por
fora do instalador (por exemplo, um `cp` ou `node -e` direto no arquivo).
Resolve rodando o instalador de novo: ele detecta a divergência, repara o
artefato e registra isso na saída como `repaired`.

Já o aviso `artifact-outdated` (impresso como `warning: ...`, sem afetar o
exit) só diz que o commit da working tree diverge do commit registrado no
`manifest.json` da versão instalada. Não quebra o isolamento; é só um
lembrete de que existe um build mais novo disponível.

## Migração 0.x para 1.0

A 1.0 é uma quebra: modelo de dados, formato em disco e tools mudam, e o dado 0.x
não é migrado, é arquivado (seção acima). Reinstale servidor e skills juntos
(`node scripts/install.ts`) e reinicie as sessões abertas: servidor antigo em
memória com skills novas responde `Input validation error`.

- O 0.x guardava Marcos e Vereditos com `supersedes` no evento. A 1.0 guarda
  **registros** de um tipo definido por `define_type`, ligados por **relações**
  (`supersedes`, `revokes`, `supports` e outras) e avaliados por **gates
  declarativos**. Não há vocabulário, `Estado` nem `state`.
- `evaluate_gate` não grava mais Marco: só calcula e devolve.
- Cada tool 0.x tem um destino:

| 0.x | 1.0 |
|---|---|
| `list` | `list` |
| `register_type` | `define_type` |
| `register_vocabulary` | sem equivalente (o vocabulário saiu) |
| `register_gate` | `define_gate` (gate vira uma lista de perguntas) |
| (novo) | `define_relation` |
| `create_process` | `create_process` |
| `register` | `register` (lote de 1 a 50 registros, atômico) |
| `evaluate_gate` | `evaluate_gate` (só leitura) |
| `state`, `events` | `query` |
| `timeline` | `query` com `scope: "project"`, e `scripts/timeline.ts` para texto grande |
| `chain` | `verify_chain` |
| `attachment` | `attach` e `read_attachment` |

- Os scripts de leitura mudaram de contrato (ver "Scripts de leitura"): `export`
  emite campos de `QueryRecord`, e `timeline` recebe prefixo de target.
- Backup de processo com anexos: copie o diretório do projeto em `<D>/.v1/`, não só
  o JSONL; `scripts/export.ts` não leva `process.json`, as definições nem
  `attachments/`.

## As 11 tools

| Tool | O que faz | Escreve |
|---|---|---|
| `list` | Descoberta: projetos, ou um projeto com processos e definições, ou o que um processo fixou | nada |
| `define_type` | Define um tipo de registro (JSON Schema) como versão imutável | `<projeto>/types/<nome>/<versão>.json` |
| `define_relation` | Define um nome de relação (`kind` e tipos permitidos nas pontas) | `<projeto>/relations/<nome>/<versão>.json` |
| `define_gate` | Define um gate: uma lista de perguntas sobre os registros | `<projeto>/gates/<nome>/<versão>.json` |
| `create_process` | Cria um processo, fixando a versão vigente de cada definição | `process.json` |
| `register` | Grava um lote de registros, atômico, com relações e `key` de idempotência | `records.jsonl` |
| `query` | Lê registros vigentes de um processo ou do projeto, com filtros, relações e mudanças desde um marcador | nada |
| `evaluate_gate` | Calcula um gate fixado no processo e devolve a evidência | nada |
| `verify_chain` | Verifica a cadeia de hash do log e os anexos citados | nada |
| `attach` | Guarda um texto como anexo imutável, por `text` ou `path` | `<projeto>/attachments/<sha256>` |
| `read_attachment` | Lê uma página de um anexo por hash | nada |

Nomes (projeto, processo, tipo, relação, gate, alias) seguem `[a-z0-9][a-z0-9-]{0,62}`.
Um `target` são nomes separados por `.`, com até 200 caracteres
(`checkout.pagamento.pix`); o prefixo de um `target` casa na fronteira de `.`:
`a.b` casa `a.b` e `a.b.c`, não `a.bc`. O id de um registro é `<processo>:<uuid v7>`
e só o servidor o atribui. `author` sai do envelope da chamada: `agent` e `model`
vêm do agente, `client` vem do cliente MCP (ou `unknown`).

Toda entrada é estrita: chave desconhecida é `INVALID_INPUT` com
`unrecognized_keys`. Os tetos de tamanho estão em
[`docs/tetos-dominio-v1.md`](docs/tetos-dominio-v1.md).

### `list`

Ferramenta de descoberta, não pré-requisito. Sem parâmetros, lista os projetos e a
contagem de processos. Com `project`, traz os processos e as definições vigentes
(tipos, relações e gates), cada uma com `version` (a mais nova) e `versions` (todas,
em ordem crescente). Com `project` e `process`, traz o que o processo **fixou**
(`pinned`, os nomes de cada tipo de definição) e os hashes das definições. O que
um processo fixou não muda depois, ao contrário da versão vigente do projeto.

### `define_type`, `define_relation`, `define_gate`

Cada chamada grava uma versão `major.minor` nova e nunca sobrescreve a anterior.
Todas devolvem `{name, version, hash, created, previousVersion?, divergentVersions?}`:

- **Nome novo:** grava `1.0`.
- **Conteúdo idêntico ao vigente:** replay, `created: false`, nada é gravado.
- **Mudança compatível:** sobe o minor.
- **Mudança que quebra:** exige `breaking: true` e sobe o major; sem a flag, é
  `BREAKING_CHANGE`.
- **Escritor concorrente** na mesma versão-alvo: a decisão é refeita contra o que
  ele gravou, e `divergentVersions` lista as versões divergentes.

O que conta como quebra varia: em `define_type`, só acrescentar propriedade
opcional ou valor de `enum` é minor; em `define_relation`, ampliar `from`/`to` é
minor e mudar `kind` ou estreitar a lista quebra; em `define_gate`, toda mudança é
minor e `breaking: true` marca o gate que ficou mais estrito.

`define_type` recebe um JSON Schema com raiz `type: "object"`. Uma propriedade com
`format: "attachment"` guarda o hash de um anexo (ver `attach`). Todo `pattern`
passa por checagem de regex catastrófico (`safe-regex2`) e exige `maxLength` no
mesmo subschema, com até 256; schema que o `ajv` não compila ou `$async` é
`INVALID_SCHEMA`, e o limite da checagem está em
[`docs/tetos-dominio-v1.md`](docs/tetos-dominio-v1.md). Um tipo fica de até 16.000
caracteres canônicos.

Um gate tem 1 a 50 perguntas de quatro formas, todas com seletor
(`type`, `targetPrefix`, `where` só com valor escalar) e `scope` opcional:

| `kind` | Passa quando |
|---|---|
| `approved` | há ao menos um registro vigente em `of`, todos com apoio vigente (de `by`, se informado) e nenhum com contradição vigente |
| `occurred` | existem ao menos `min` (padrão 1) registros vigentes que casam `select` |
| `no_pending` | todo registro vigente de `pending` tem uma resolução vigente (relação `resolvedBy.kind`, de `resolvedBy.from`) |
| `no_open_contradiction` | nenhum registro vigente (de `of`, se informado) tem contradição vigente |

### `create_process`

Cria um processo e fixa para sempre a versão vigente de cada tipo, relação e gate do
projeto. **Idempotente por nome**: se o processo já existe, devolve o existente
sem alterar nada (`created: false`), com `stale` listando as definições que mudaram
desde a fixação (`{kind, name, current}`). Projeto sem nenhuma definição é
`TYPE_NOT_FOUND`, sem criar nada. Nomes reservados de processo (`types`,
`relations`, `gates`, `attachments`, `archive`) são `RESERVED_NAME`. A ordem das
recusas é: nome reservado, depois projeto sem definição e só então a criação ou o
`created: false`; por isso um processo que já existe, num projeto que ficou sem
definição, também recebe `TYPE_NOT_FOUND`.

### `register`

Grava um lote de 1 a 50 registros numa **única linha** do log, atômico: ou todos
entram ou nenhum. Cada item traz `type` (um tipo fixado no processo), `target`,
`data` (validado pelo schema do tipo, até 16.000 caracteres canônicos), `alias`
opcional e `relations` opcionais. Devolve `{records, replayed, marker}`: os ids na
ordem de entrada (com o `alias` de cada um, quando houver) e o marcador, a cabeça do
processo, para ler dali em diante.

Uma relação aponta para um id existente ou para `@alias` de um item **anterior** do
mesmo lote, e leva `kind` (`supersedes`, `revokes`, `supports`, `contradicts`,
`answers`, `derivesFrom`, `complements`, `reopens`), `as` (um nome de relação definido
no projeto) ou os dois. Até 100 relações por registro. As regras:

- `supersedes` e `revokes` só alcançam registros **do mesmo processo**
  (`cross-process-currency`), e só o vigente: sobre um destino que já foi superado ou
  revogado, é `FORK_REJECTED`, com `current` apontando a versão atual da linhagem.
- `supersedes` exige o mesmo tipo (`type-mismatch`).
- `supports` só aceita destino vigente (`stale-destination`); pode cruzar processos.
- Um registro não pode apoiar e contradizer, nem superar e revogar, o mesmo destino.
- Relação para si mesmo, `as` que não existe fixado no processo e `kind` que não
  bate com o do nome são `INVALID_RECORD`; ciclo é `CYCLE_REJECTED`; destino
  inexistente é `RELATION_NOT_FOUND`.
- Citar o hash de um anexo num campo com `format: "attachment"` exige o anexo
  guardado e íntegro (`ATTACHMENT_NOT_FOUND`, `ATTACHMENT_CORRUPTED`); um hash de anexo
  guardado num campo sem a marca é recusado (`unmarked-attachment`).

**`key` e retentativa.** Com `key` (até 200 caracteres), o mesmo lote devolve o
resultado já gravado com `replayed: true`, sem gravar; a mesma `key` com outro lote é
`IDEMPOTENCY_CONFLICT`. Depois de `IO_ERROR` o resultado é incerto: reenvie com a
mesma `key`. A `key` é procurada antes das checagens que dependem de estado, então um
reenvio devolve `replayed` mesmo que o estado tenha mudado entre as chamadas. Um
reenvio feito depois de um `fsync` que falhou não garante o lote no disco, e depois de
um cancelamento só um `ATTACHMENT_NOT_FOUND` no reenvio não prova a ausência do anexo:
guarde o anexo e reenvie com a mesma `key` (ADR 0009).

A ordem das recusas é fixa, e responde a primeira que falha: forma do lote
(`INVALID_INPUT`); processo inexistente ou manifesto ilegível; recusas estáticas
(tipo fixado, schema, `as`, `cross-process-currency`); cadeia quebrada
(`PROCESS_CORRUPTED`); `key`; checagens de estado e regras de relação (ADR 0008).

### `query`

Lê os registros **vigentes** (não superados nem revogados) de um processo
(`scope: "process"`, o padrão, exige `process`) ou de todos os processos do projeto
(`scope: "project"`). Os dois verificam a cadeia na leitura; processo com cadeia
quebrada ou manifesto ilegível falha fechado com `PROCESS_CORRUPTED` nomeando o
processo em `details[0].process`.

- **Alcance processo** lê um processo só: `in` traz só relações vindas do próprio
  processo, e `out` para um registro de outro processo sai sem `current`. Quem espera
  evidência de outro processo declara `scope: "project"`.
- **Filtros:** `type`, `targetPrefix`, `where` (igualdade em campos de primeiro nível
  de `data`, valor escalar, até 50 chaves), `text` (busca textual, até 200
  caracteres, por relevância), `ids` (até 200), `relatedTo` (registros ligados a um id)
  e `includeNonCurrent` (traz também os superados e revogados). Uma consulta com `text`
  monta o índice na própria chamada.
- **Cada registro** traz `id`, `type`, `at`, `target`, `author`, `data`, as relações
  de entrada (`in`) e de saída (`out`), `needsReview` (registro vigente cujo apoio
  morreu: `staleIn` e `staleOut`) e `attachmentStatus` (`ok`, `missing` ou
  `corrupted` por anexo citado). Anexo ausente ou adulterado aparece como status, não
  como erro.
- **Ordem:** por `seq` no alcance processo, por (`at`, processo, `seq`) no alcance
  projeto, e por relevância com `text`.
- **Paginação:** até `limit` registros (padrão 50, máximo 200), e a página também para
  num teto de 24.000 caracteres, sempre com ao menos um registro. Passe o `cursor`
  devolvido para continuar; o cursor prende a consulta e o marcador da primeira página,
  então `INVALID_CURSOR` ou `MARKER_NOT_FOUND` indicam que a consulta ou o dado mudou.
- **Mudanças:** `marker` é a cabeça de cada processo lido. Devolvido como
  `changesSince` numa consulta nova, a primeira página traz `changes` (`entered` e
  `left` com o motivo: `superseded`, `revoked` ou `no-longer-matches`). Cada lista vai
  até 100 ids; quando vem `omitted`, as listas são parciais e esse marcador não deve
  ser reusado como `changesSince`: releia tudo.

### `evaluate_gate`

Calcula um gate fixado no processo, **sem gravar nada**. Devolve `passed`, o
resultado de cada pergunta (`index`, `kind`, `passed`, `evidence` com os ids que
sustentam a resposta) e o `marker` do que foi lido. `target` é herdado pelos
seletores sem `targetPrefix`. Com um `marker` de uma leitura anterior, a avaliação se
reproduz sobre os registros que existiam então. Cada lista de evidência vai até 100
ids, com `omitted` contando o resto; um `select` ou `where` mais estreito alcança o
resto. Gate não fixado no processo é `GATE_NOT_FOUND`.

### `verify_chain`

Verifica a sequência, o encadeamento de hash a partir da âncora (o hash de
`process.json`) e os anexos que os registros citam. Cadeia quebrada é **resultado**,
não erro: `ok` só é `true` com `breaks` e `attachmentBreaks` vazios. Devolve
`totalRecords`, `head`, `breaks` e `totalBreaks` (da cadeia, com `reason`
`invalid-line`, `diverging-seq` ou `hash-mismatch`), `attachmentBreaks` e
`totalAttachmentBreaks` (`attachment-missing` ou `attachment-corrupted`, por registro
e hash) e `repairedLines`. Cada lista vai até 100 itens, com o total real ao lado.
Restos de gravações que falharam não quebram a cadeia: a cauda sem `\n` entra se for um elo
válido (o lote ficou inteiro e só faltou o `\n`), e linhas rasgadas seguidas de um elo
válido aparecem em `repairedLines`; o resto rasgado no fim é ignorado e não consome `seq`. Trocar, remover ou
alterar uma linha válida segue sendo quebra.

### `attach` e `read_attachment`

`attach` guarda um texto grande (relatório de um agente, plano) endereçado pelo
sha256 dos **bytes** UTF-8, por projeto, em `<projeto>/attachments/<sha256>`. O texto
integral fica fora do registro: o registro leva só o hash, num campo do tipo marcado
com `format: "attachment"`. Informe exatamente um entre:

- `text`: um texto de até 1 MiB **em bytes** (não em caracteres), não vazio e sem
  surrogate solto. Devolve `{hash, bytes, deduplicated}`; o mesmo texto dá sempre o
  mesmo hash e regravá-lo é seguro (`deduplicated: true`, um só arquivo). Se o blob
  existente não bater com o hash, o put falha com `ATTACHMENT_CORRUPTED` e não o
  sobrescreve.
- `path`: um arquivo `.md` ou `.txt` (extensão exata, em minúsculas), relativo ao `cwd`
  do servidor ou absoluto, em qualquer subpasta de `realpath(<cwd do servidor>)` (o `cwd`
  que o Claude Code herdou) e **fora** de `realpath(<D>)`; regular, de um único link
  (hardlink é recusado), não vazio, de até 1 MiB e em UTF-8 válido. O teto é o `cwd`:
  com a sessão iniciada em `$HOME`, todo `.md` e `.txt` sob ele fica ao alcance e o
  conteúdo volta ao modelo por `read_attachment`. Esse caminho escapa dos `Read(...)`
  de deny e do hook, porque o servidor MCP não passa por eles, então o `cwd` é a
  fronteira de confidencialidade. Só `.md` e `.txt`, por não carregarem credencial
  como `.json`, `.log` e `.env`; ampliar o alcance exige um ADR novo (0009). O
  diretório é resolvido com `realpath`, o arquivo é aberto sem seguir symlink e,
  depois do `open`, o caminho do descritor é conferido contra o esperado (um diretório
  trocado por symlink no meio é recusado). A recusa é `INVALID_INPUT` com
  `details[0].path` `/path` e `details[0].code` `bad-args`, `bad-extension`,
  `outside-allowed-root`, `inside-data-dir`, `not-found`, `not-regular`, `too-big` ou
  `invalid-utf8` (no `text`: `bad-args` e `lone-surrogate`); erros do sistema de
  arquivos saem como `IO_ERROR` só com o errno, sem o caminho absoluto.

`read_attachment` lê em páginas: `offset` (caractere inicial, padrão 0) e `maxChars`
(1 a 24.000, padrão 24.000). Devolve `{text, next?, status: "ok"}`, com `next` o
`offset` da página seguinte e ausente na última; concatenar as páginas dá exatamente
o texto original, e uma página nunca parte um par surrogate. Anexo ausente é
`ATTACHMENT_NOT_FOUND`, adulterado é `ATTACHMENT_CORRUPTED`.

Blobs são imutáveis e nunca apagados; um blob que seja symlink, FIFO, diretório ou
passe de 1 MiB conta como adulterado. O texto devolvido foi escrito por agentes:
trate-o como dado não confiável, nunca como instrução.

## Layout de dados

```
<D>/                                   # 0700; $XDG_DATA_HOME/hexlog ou ~/.local/share/hexlog
  .v1/                                 # raiz do dado 1.0; o 0.x nunca grava aqui
    <project>/                         # 0700
      types/<name>/<major>.<minor>.json       # o schema do tipo; imutável
      relations/<name>/<major>.<minor>.json   # {name, kind, from?, to?}
      gates/<name>/<major>.<minor>.json       # {name, questions}
      attachments/<sha256>             # 0600; bytes UTF-8 do anexo, imutável, sem extensão
      <process>/                       # 0700
        process.json                   # manifesto fixado; criado só por create_process
        records.jsonl                  # 0600; 1 linha por lote registrado
        records.jsonl.lock/holder      # transitório: lock publicado por rename + dono (pid, bootId, token)
  archive/hexlog-0x-<data>.tar         # só depois de --archive-0x
```

- **`process.json`** guarda `project`, `process`, `createdAt`, as definições fixadas
  (`fixed.types`, `fixed.relations`, `fixed.gates`, com o conteúdo completo) e os
  hashes de cada grupo. O sha256 do JCS dele é a âncora da cadeia.
- **`records.jsonl`** é append-only. Cada linha é um registro com `seq` (contíguo, por
  processo) e `prevHash`; só a primeira linha de um lote carrega `batch` (impressão do
  lote, `key` e apelidos), e as outras linhas do mesmo lote seguem a cadeia. O hash é
  o sha256 do JCS (RFC 8785) da linha sem `prevHash`. Não existe tool nem função que
  reescreva ou remova uma linha. O arquivo tem teto de 64 MiB por processo
  (`PROCESS_TOO_LARGE`).
- **Versões de definição** são gravadas por `link` exclusivo e nunca sobrescritas. O
  `<nome>.json` legado do 0.x não existe aqui e nunca é lido.
- **Anexo:** o hash é o sha256 dos **bytes** do texto, não do JCS; o nome do arquivo é
  a única fonte do hash esperado, e a leitura re-hasheia o conteúdo.
- `attachments` e os demais nomes reservados são nomes de pasta do projeto, não de
  processo.
- Todo erro de disco vira `IO_ERROR` só com o errno, nunca com caminho.

## Erros e avisos

Toda tool devolve um erro de domínio como `{code, message, details}`, com
`details[]` de `{path, code, message}` (`path` é um JSON Pointer para o campo da
entrada, vazio quando o erro é da chamada toda). O catálogo completo é
`src/errors.ts#ErrorCode`. Alguns dos mais comuns:

| Código | Quando |
|---|---|
| `INVALID_INPUT` | entrada fora do schema, chave desconhecida, `__proto__`, ou `attach` com `path` recusado (o motivo vem em `details[0].code`) |
| `INVALID_FILTER` | filtro da `query` inconsistente (`process` ausente no alcance processo, `text` em branco ou acima de 200 caracteres, `limit` inválido) |
| `INVALID_CURSOR` / `MARKER_NOT_FOUND` | `cursor`, `changesSince` ou `marker` que não batem com o dado lido |
| `RESERVED_NAME` | nome de processo reservado |
| `INVALID_SCHEMA` | schema de tipo que o `ajv` recusa, `pattern` sem `maxLength` ou com regex catastrófico |
| `BREAKING_CHANGE` | `define_*` com mudança que quebra, sem `breaking: true` |
| `PROJECT_NOT_FOUND` / `PROCESS_NOT_FOUND` | projeto ou processo inexistente |
| `TYPE_NOT_FOUND` / `GATE_NOT_FOUND` / `RELATION_NOT_FOUND` | definição ou versão inexistente (`details[0].code` `unknown-name` ou `unknown-version`, com `versions`), ou destino de relação inexistente |
| `TYPE_NOT_PINNED` | tipo que o processo não fixou |
| `INVALID_RECORD` | `data` reprovado pelo schema, ou relação que viola uma regra (item, relação e regra no `path`) |
| `FORK_REJECTED` | `supersedes` ou `revokes` sobre registro que já não é vigente (`current` traz a versão atual, ou `null`) |
| `CYCLE_REJECTED` | relação que fecharia um ciclo |
| `IDEMPOTENCY_CONFLICT` | mesma `key` com outro lote |
| `ATTACHMENT_NOT_FOUND` / `ATTACHMENT_CORRUPTED` | o blob não existe, ou o sha256 dos bytes não bate com o nome |
| `PROCESS_CORRUPTED` | cadeia quebrada (`broken-chain`) ou `process.json` ilegível (`unreadable-manifest`); ver "Recuperar um processo corrompido" |
| `PROCESS_TOO_LARGE` | `records.jsonl` no teto de 64 MiB |
| `LOCK_TIMEOUT` | `lock-busy` (dono vivo por mais de 15 s, com o `pid`), `lock-lost` (o lock foi perdido antes da gravação) ou `holder-unreadable`; ver abaixo |
| `LEGACY_DATA` | há dado 0.x em `<D>`; ver "Dado 0.x: arquivamento" |
| `IO_ERROR` | erro de disco, só com o errno |
| `INTERNAL` | exceção inesperada, sem stack na resposta |

O erro vai só em `content[0].text` da resposta MCP, com `isError: true`.

## Tetos do lock e destravamento manual

Cada processo tem um lock, o diretório `records.jsonl.lock/` dentro da pasta do
processo, em `<D>/.v1/<projeto>/<processo>/`. Só o `register` o segura, e só o da
origem: a leitura de um destino em outro processo não trava. O dono é identificado por
`pid`, `bootId` (o boot id do kernel) e token. Um lock órfão (de outro boot, ou do
mesmo boot com `pid` morto) é roubado; um dono vivo nunca é. Um escritor espera um
dono vivo por até 15 s e então recebe `LOCK_TIMEOUT` `lock-busy`, com o `pid` do dono.

**Tetos aceitos** (ADR 0009):

- **Mesma máquina e mesmo namespace de pid.** Container ou sandbox dividindo `<D>`
  faz o `kill(pid, 0)` dar `ESRCH` para um dono vivo, e o lock vivo é roubado: não
  compartilhe `<D>` entre namespaces.
- **Reuso de pid** por processo alheio no mesmo boot deixa o lock preso até a
  intervenção manual. O `bootId` tira desse teto tudo o que vem de reboot.
- **`holder-unreadable`:** o `holder` vazio, fora de JSON ou sem `pid` e `token`. Repetir
  a chamada nunca resolve, e o servidor não rouba esse lock.
- **Roubo concorrente com leitura velha:** se um segundo escritor adquirir no meio da
  janela de microssegundos entre o roubo e a devolução do lock, duas escritas
  concorrem e o processo fica **permanentemente** corrompido (`diverging-seq`), até a
  recuperação manual abaixo. Exige dois ladrões sobre o mesmo órfão.
- **Lock devolvido a um dono que desistiu** e cuja sessão nunca mais grava nesse
  processo fica preso até a sessão fechar; a próxima gravação dela cura o caso.
- **`lock-lost` e `lock-busy` raros:** medidos sob 2x de CPU, 2 de 20 rodadas deram
  `lock-lost` e 1 de 20 deu `lock-busy`. A cadeia segue íntegra e o erro é retentável
  com a mesma `key`.

### Destravar um processo (`holder-unreadable`)

`LOCK_TIMEOUT` com `code: "holder-unreadable"` não é retentável, e o mesmo
destravamento resolve o reuso de pid e o dono que desistiu. O Bash do agente
não alcança `<D>` por caminho literal (o hook o nega), então o destravamento é feito
pelo usuário, num terminal fora do Claude Code:

1. Feche as sessões do Claude Code que usam o hexlog, para nenhum servidor estar
   gravando nesse processo.
2. Confira o `holder`: `cat <D>/.v1/<projeto>/<processo>/records.jsonl.lock/holder`.
   Se ele traz um `pid` vivo de um servidor hexlog (`ps -p <pid>`), esse servidor é o
   dono e o lock é legítimo: espere ou feche-o.
3. Com o `holder` ilegível, o `pid` morto ou o `pid` vivo de um processo que não é
   servidor hexlog (reuso de pid), apague o lock:
   `rm -r <D>/.v1/<projeto>/<processo>/records.jsonl.lock`.
4. Confira que `records.jsonl.lock` não está mais na pasta do processo
   (`ls <D>/.v1/<projeto>/<processo>`). A prova de que o processo volta a gravar é o
   próximo `register` numa sessão nova; `export.ts` e `verify_chain` leem sem o lock,
   então não provam o destravamento.

O servidor cria o lock por `rename` com `fsync` do `holder`, então um `holder`
ilegível não é um estado transitório: só aparece depois de uma falha do disco ou de
edição por fora. Restos `*.tmp-*`, `*.dead-*` e `*.released-*` ao lado do lock só
sobram se um processo morreu no meio da troca; nenhum leitor os abre e podem ser
apagados.

## Recuperar um processo corrompido (`PROCESS_CORRUPTED`)

Um processo com cadeia quebrada fica ilegível para escrita (`register` dá
`PROCESS_CORRUPTED` `broken-chain`), e bloqueia as leituras de alcance projeto, que
falham fechado nomeando o processo em `details[0].process`. O alcance processo dos
outros processos segue funcionando. `verify_chain` no processo diagnostica onde a
cadeia quebra (`breaks`), e o `process.json` ilegível aparece como
`unreadable-manifest`. Não há tool de reparo: o log é append-only.

A recuperação é manual, num terminal fora do Claude Code (ADR 0009):

1. Feche as sessões do Claude Code.
2. Tire o processo do caminho, preservando-o para auditoria:
   `mkdir -p ~/hexlog-quarantine-$(date +%F) && mv <D>/.v1/<projeto>/<processo> ~/hexlog-quarantine-$(date +%F)/`.
3. O alcance projeto volta a funcionar e o nome do processo fica livre para
   `create_process`. Uma relação já gravada que apontava para ele passa a sair sem
   `current`, e uma relação nova para ele dá `RELATION_NOT_FOUND`.

## Lacunas de isolamento

O isolamento do hexlog combina 4 regras de deny (`Read`/`Edit` sobre o
diretório de dados, mais `Edit` sobre o artefato instalado) com um hook
PreToolUse na tool Bash que tokeniza o comando e nega quem alcançar o
diretório de dados. A mensagem de negação cita as tools que dão acesso ao dado
(`list`, `query`, `verify_chain`, `read_attachment`, `evaluate_gate`). Esse hook
sempre falha aberto: qualquer exceção interna, Node ausente ou arquivo do hook
apagado deixa o comando passar sem avisar o agente. Só o `--check` detecta essa
condição. O servidor MCP não passa pelo deny nem pelo hook: a fronteira dele é o
`cwd` do `attach` por `path` (ver acima).

Por desenho, isso deixa lacunas conhecidas, aceitas com a expectativa de que
o teste automatizado as marque como "passa":

| Lacuna | Exemplo |
|---|---|
| `cd` seguido de caminho relativo | `cd ~/.local/share && cat hexlog/.v1/p/r/records.jsonl` |
| `grep -r` no diretório pai | `grep -r foo ~/.local/share/` |
| Subprocessos | `node -e …`, `python -c …` |
| Os scripts de leitura do próprio hexlog | `node scripts/export.ts p/q`, `node scripts/timeline.ts p t --full` e `node scripts/insights.ts`: o script resolve `<D>` sozinho, e um agente com Bash despeja o log e os anexos por eles |
| Grep/Glob tool do Claude Code apontando pro pai | `Grep path=~/.local/share` |
| Variável definida no mesmo comando | `d=~/.local/share; cat $d/hexlog/x` |
| ANSI-C quoting | `cat $'/home/…/hex\x6cog/x'` |
| Alternância de zsh | `cat ~/.local/share/(hexlog\|x)/p/r/records.jsonl` |
| Hook indisponível | Node removido pelo nvm, `~/.local/lib/hexlog/<versão>/` apagado à mão, ou instalação corrompida por fora |
| Alteração do artefato instalado por Bash/subprocesso | `cp x ~/.local/lib/hexlog/1.0.0/bash-guard.mjs`, `node -e "fs.writeFileSync(...)"`: o deny de `Edit` só cobre as tools Edit/Write/NotebookEdit, não Bash |
| Desligar o guard editando a configuração | Editar `~/.claude/settings.json` à mão para remover deny ou hook |
| Reinstalar a partir de código alterado | Editar `hook/bash-guard.ts` na working tree e rodar o instalador |

As duas últimas linhas sobre o artefato instalado são detectadas e reparadas
pelo próprio instalador e pelo `--check` (`artifact-modified`), como descrito
acima em Verificação.

**Falsos positivos aceitos** (o guard nega um comando inofensivo): um comando
que só cita o diretório de dados literalmente, como
`git commit -m "… ~/.local/share/hexlog …"`; um caminho entre aspas duplas
que o shell não expande mas o hook trata como caminho; e um `**` ou uma chave
`{a,b}` com barra cujo prefixo literal é ancestral do diretório de dados,
como `ls ~/**/*.md` ou `ls ~/{docs/a,b}`. Um `**` dentro de outros
repositórios (por exemplo `/caminho/do/repo/**/*.ts`) não é afetado, porque
o prefixo não é ancestral do diretório de dados.

## Como reverter

1. Restaurar `~/.claude/settings.json.bak-hexlog` sobre `~/.claude/settings.json`,
   ou remover manualmente as 4 regras de deny e a entrada do hook do hexlog
   em `hooks.PreToolUse`.
2. `claude mcp remove hexlog -s user`.
3. `rm -rf ~/.local/lib/hexlog`.
4. `rm -rf ~/.claude/skills/hexlog ~/.claude/skills/hexlog-flow ~/.claude/skills/hexlog-setup`.
   O instalador grava essas skills e nenhum dos passos acima as remove.

Os dados já registrados em `<D>` não são apagados por nenhum desses passos. Para
voltar ao servidor 0.x, veja "Voltar ao 0.x".

## Desenvolvimento

```sh
npm test            # jest: testa o código-fonte .ts diretamente
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format:check
npm run build       # esbuild, gera os bundles .mjs (equivalente ao passo 1 do instalador)
```

Os specs de orçamento de tempo (`*.budget.spec.ts`) ficam fora do `npm test` e rodam
em série em `npm run test:budget`, no CI.

### Scripts de leitura

`scripts/insights.ts`, `scripts/export.ts` e `scripts/timeline.ts` são CLIs
read-only, sem tool MCP correspondente: rodam direto com `node`, leem
`XDG_DATA_HOME` como as tools, não recebem o caminho do diretório de dados na
linha de comando e leem só por `src/compose.ts`, que verifica a cadeia na leitura. Nunca
importam `src/adapters/**` nem `src/mcp/**` e nunca escrevem no diretório de dados. A
tabela de exit codes dos três está em `scripts/AGENTS.md`; em resumo, dado 0.x em `<D>`
(`LEGACY_DATA`) sai com 2 nos três, e `PROCESS_CORRUPTED` (cadeia adulterada incluída)
sai com 2 em `export` e `timeline`, mas com 1 em `insights`, que reporta integridade
quebrada como achado do relatório.

### `scripts/export.ts`

```sh
node scripts/export.ts <project>/<process> [--fields a,b,c]
```

Imprime em stdout uma linha JSON por registro do processo, vigentes ou não
(JSONL), com os campos de `QueryRecord` (`id`, `type`, `at`, `target`, `author`,
`data`, `in`, `out`, `needsReview`, `attachmentStatus`). Não emite `seq`, `prevHash`
nem `relations`: a relação sai como `in` e `out`. Com `--fields`, cada linha só traz
as chaves pedidas, e `seq`, `timestamp`, `agent` e `prevHash`, do 0.x, são recusados
como campo desconhecido. O processo sai numa consulta só, carregado inteiro em
memória (o teto de 64 MiB por processo limita o tamanho). Erro de uso, processo
inexistente e campo desconhecido saem com `export failed: ...` em `stderr` e código
`1`.

### `scripts/timeline.ts`

Consulta de alcance projeto com os registros não vigentes e as relações, sem teto de
página nem de texto por entrada: é o caminho para ler anexos grandes.

```sh
node scripts/timeline.ts <project> <target-prefix>... [--full] [--json]
```

Cada argumento depois do projeto é um prefixo de target, com a fronteira de `.`. A
saída padrão é legível: uma seção `target <prefixo>: <n> records` por prefixo e um
bloco por registro, com as marcas `[superseded by <id>]` e `[revoked by <id>]` e as
relações de entrada e saída; não há linhas de cadeia (a leitura de alcance projeto já
falha fechada). `--full` imprime o texto de cada anexo íntegro, byte a byte, entre
`----- attachment <hash> (<n> bytes) -----` e `----- end -----`. `--json` imprime
JSONL: uma linha `{"kind":"record", ...}` por registro, com o prefixo consultado em
`query` e, com `--full`, o texto dos anexos em `attachmentText`. O alcance projeto lê
todos os processos numa chamada só, e o teto de 64 MiB vale por processo: o consumo de
memória soma o projeto. Os avisos de anexo ausente ou adulterado vão para `stderr`.
Códigos de saída: `0` tudo íntegro; `2` cadeia ou `process.json` quebrado, anexo
ausente ou adulterado e dado 0.x; `1` uso incorreto ou erro (`timeline failed: CODE:
msg`).

**O modo texto imprime o texto do anexo verbatim.** O anexo e os campos livres vêm
de agentes e não são confiáveis. Um anexo com a linha `----- end -----` forja o
delimitador, e um agente com prompt injetado grava o próprio log, então a vítima é
quem lê o terminal (a cadeia segue íntegra). Além disso, ESC, CSI e OSC (por exemplo
o OSC 0 de título) no texto do anexo podem, conforme o terminal e sua configuração,
ser interpretados por quem roda `timeline --full`. Os campos `data`, `needsReview` e
`author.agent` saem por `JSON.stringify` em `scripts/timeline.ts#renderEntry`, que
escapa C0 mas não C1: U+009B e U+009D saem crus mesmo sem `--full`, e alguns
terminais, por exemplo os baseados em VTE, os tratam como CSI e OSC. O escape de
terminal no modo texto está numa issue de follow-up, sem decisão tomada. **Para log
não confiável use `--json --full`**, que escapa tudo.

### `scripts/insights.ts`

```sh
node scripts/insights.ts [projeto[/processo]]
```

Relatório markdown de integridade da cadeia, linha do tempo e sinais da `key` (possível
duplicata sem chave, chave em excesso e percentual de lotes com chave por tipo) sobre
os registros do hexlog. Sai `1` com cadeia ou anexo quebrado, falha de leitura ou
filtro sem resultado, e `2` com dado 0.x em `<D>`. A chave em excesso é um proxy: o
reenvio com a mesma `key` devolve `replayed` sem gravar, então o log não registra
"nunca teve reenvio" (ADR 0009).

### Testes

O jest testa o `.ts` fonte; os testes de ponta a ponta sobem o servidor a
partir do bundle já construído (`.mjs`), para cobrir o artefato que as
sessões de fato executam. Os testes do instalador substituem as execuções
externas (hook, servidor, `claude mcp`) por injeção, incluindo
`HEXLOG_REGISTER_MCP=<script>` para trocar `claude mcp add`/`remove` por um
script de teste sem depender do binário `claude` nem tocar no
`~/.claude.json` real.

## Links

- [ADR 0007: domínio](docs/adr-0007-dominio.md)
- [ADR 0008: serviços](docs/adr-0008-servicos.md)
- [ADR 0009: ferramental](docs/adr-0009-ferramental.md)
- [Tetos de tamanho do domínio](docs/tetos-dominio-v1.md)
- [Pesquisa de bibliotecas](docs/pesquisa/hexlog-pesquisa-libs.md)
