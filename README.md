# hexlog

Servidor MCP stdio para agentes registrarem seu próprio histórico de trabalho:
decisões, marcos e veredictos, com um log append-only e cadeia de hash por
processo. Expõe exatamente 10 tools. Não tem CLI nem daemon: só o servidor
MCP e um hook de isolamento instalados no Claude Code.

Os dados ficam em `$XDG_DATA_HOME/hexlog/` (ou `~/.local/share/hexlog` se a
variável estiver ausente, vazia ou não for um caminho absoluto), um diretório
por projeto e, dentro dele, um log JSONL por processo. Cada linha do log referencia o hash da anterior, então qualquer
alteração ou remoção de linha quebra a cadeia de forma detectável pela tool
`chain`.

## Requisitos

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

`node scripts/install.ts` faz três coisas:

1. Constrói o servidor e o hook com `esbuild` e verifica o artefato preparado
   antes de trocar qualquer coisa (o hook precisa negar o diretório de dados e
   permitir o resto; o servidor precisa subir e anunciar as 10 tools).
2. Copia os dois bundles para `~/.local/lib/hexlog/<versão>/`, fora da working
   tree e fora do diretório de dados. É essa cópia que as sessões executam.
3. Registra as 4 regras de deny e o hook PreToolUse em
   `~/.claude/settings.json` (com backup em `settings.json.bak-hexlog` antes
   de qualquer troca) e registra o servidor MCP em escopo `user`.

**Mudar código no repositório não afeta nenhuma sessão em andamento nem novas
sessões até rodar o instalador de novo.** As sessões sempre executam a cópia
de `~/.local/lib/hexlog/<versão>/`, nunca a working tree.

Rodar o instalador de novo sem nada ter mudado imprime que a versão já está
instalada e íntegra, e não toca em `settings.json` nem no MCP.

## Verificação (`--check`)

```sh
node scripts/install.ts --check
```

Rode isso depois de: reinstalar o harness do Claude Code, trocar de versão do
Node pelo nvm, mexer manualmente em `~/.local/lib/hexlog/`, ou quando uma
instalação anterior avisou `artifact-outdated`.

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
| `hook-file` | o `bash-guard.mjs` referenciado no hook não existe em disco |
| `node` | o executável do Node referenciado no hook não existe |
| `hook-not-denying` | o hook instalado não devolveu exit 2 para um comando que deveria negar |
| `hook-not-allowing` | o hook instalado não devolveu exit 0 para um comando inofensivo |
| `mcp` | `~/.claude.json` não tem `mcpServers.hexlog` apontando pro servidor esperado |
| `artifact-modified` | os bytes de `server.mjs` ou `bash-guard.mjs` instalados divergem do `manifest.json` da própria versão |

Qualquer item na lista de faltando encerra o `--check` com exit 1.

`artifact-modified` significa que o artefato instalado foi modificado por
fora do instalador (por exemplo, um `cp` ou `node -e` direto no arquivo).
Resolve rodando o instalador de novo: ele detecta a divergência, repara o
artefato e registra isso na saída como `repaired`.

Já o aviso `artifact-outdated` (impresso como `warning: ...`, sem afetar o
exit) só diz que o commit da working tree diverge do commit registrado no
`manifest.json` da versão instalada. Não quebra o isolamento; é só um
lembrete de que existe um build mais novo disponível.

## Versões antigas

O instalador nunca apaga versões antigas de `~/.local/lib/hexlog/`. A remoção
é manual, e só deve ser feita para versões **não registradas** em
`settings.json`/`~/.claude.json`, e **só depois de reiniciar todas as sessões
abertas**: uma sessão iniciada antes da troca de versão mantém o servidor
antigo carregado em memória e pode continuar chamando o caminho antigo do
hook mesmo depois de o diretório ser removido.

## Instalação concorrente

Se dois processos de instalação rodarem ao mesmo tempo, um deles pode
terminar com a mensagem "outra instalação trocou `<versão>` ao mesmo tempo;
rode o instalador de novo". Nesse caso, espere a outra instalação terminar e
rode `node scripts/install.ts` de novo.

## As 10 tools

| Tool | O que faz | Escreve |
|---|---|---|
| `list` | Lista projetos, ou detalha um projeto, processo ou tipo fixado | — |
| `register_type` | Registra uma nova versão do schema JSON de um tipo de evento custom | `schemas/<type>/<versão>.json` |
| `register_vocabulary` | Registra uma nova versão do vocabulário de um dono do projeto | `vocabulary/<owner>/<versão>.json` |
| `register_gate` | Registra uma nova versão do critério de um gate custom | `gates/<gate>/<versão>.json` |
| `create_process` | Cria um processo, fixando o snapshot atual de tipos/vocabulário/gates | `process.json` |
| `register` | Registra um evento (Marco, Veredito ou tipo custom fixado) | `events.jsonl` |
| `evaluate_gate` | Avalia um gate contra um alvo e grava o resultado como Marco de gate | `events.jsonl` |
| `state` | Projeta o Estado atual do processo (vigentes, conflitos, órfãos, avisos, cadeia) | — |
| `events` | Lista os eventos do log, em ordem física ou por busca textual | — |
| `chain` | Verifica a integridade da cadeia de hash do log | — |

### `list`

Sem parâmetros, lista os projetos existentes. Com `project`, detalha esse
projeto: tipos, vocabulários e gates trazem `version` (a vigente, que muda a
cada novo `register_*`) e `versions` (todo o histórico, do legado `1.0` até a
mais nova). Com `project` + `process`, detalha o processo (hashes do
snapshot fixado, tipos, vocabulário, gates) — inclui `versions` só se o
processo foi criado depois da leva de versionamento; um `process.json`
legado não tem esse bloco. Ali `versions` é **fixado** na criação do
processo (a versão de cada definição naquele instante) e não muda depois,
ao contrário do `version` do nível-projeto, que é sempre a vigente em disco.
Com `type` também informado, devolve o schema JSON fixado desse tipo. Sempre
traz os gates embutidos disponíveis. `process` sem `project`, ou `type` sem
`process`, é `INVALID_INPUT`.

### `register_type`, `register_vocabulary`, `register_gate`

Registram, respectivamente, o schema JSON de um tipo custom, o vocabulário
(`milestoneType`, `result`, `action`) de um dono do projeto, e o critério de um
gate custom. Cada registro cria uma versão nova em `major.minor`, nunca
sobrescreve a anterior. Todas devolvem
`{project, name (ou owner), hash, version, previousVersion, unchanged, warnings}`,
com `hash` sendo o sha256 do JSON canônico (JCS) do conteúdo registrado.

- **Nome novo** (sem versão vigente): grava `1.0` direto.
- **Conteúdo idêntico ao vigente**: no-op — devolve `unchanged: true` com a
  versão vigente, nada é gravado.
- **Mudança compatível**: bumpa minor.
- **Mudança quebra** (ver critério abaixo): bumpa major, mas só com
  `breaking: true` no input; sem a flag, lança o erro `BREAKING_CHANGE`.
  Passar `breaking: true` numa mudança que não quebra vira minor com o aviso
  `NO_BREAKING_CHANGE` em `warnings`, em vez de forçar major.

O que conta como quebra (o que faria um evento antes válido ser rejeitado)
varia por tipo de definição:

| Definição | Quebra é |
|---|---|
| `type` | qualquer mudança no schema JSON |
| `vocabulary` | remover um termo de `milestoneType` ou `action` (campos fechados). Remover de `result` não é quebra — é campo aberto |
| `gate` | nada — `criteria` nunca quebra |

O arquivo legado `<nome>.json` (de antes do versionamento) nunca é apagado,
reescrito ou copiado: continua sendo a fonte da versão `1.0` para sempre, e
o diretório de versões, quando existe, começa em `1.1`.

### `create_process`

Cria um processo novo, fixando para sempre o snapshot atual de tipos,
vocabulário e gates do projeto. **Idempotente**: se `process` já existir,
devolve o processo existente com `existed: true` em vez de erro — hashes
iguais ao snapshot fixado, sem aviso; hashes diferentes (algo foi registrado
no projeto depois da fixação), aviso `STALE_DEFINITIONS` em `warnings`, com
`details: [{ section, name, pinned, current }]` do que mudou. Duas chamadas
concorrentes para o mesmo `process` novo: a que perde a corrida do link
exclusivo também segue esse caminho — as duas terminam com sucesso, só uma
com `existed: false`. Falha com `VOCABULARY_MISSING` se o projeto não tiver
nenhum vocabulário registrado ainda.

### `register`

Registra um evento. O `id` pode ser:

- **prefixo** `{project}:{process}:{type}`: o servidor gera um uuid v7 novo e
  faz o append;
- **id completo** `{project}:{process}:{type}:{uuid}`, devolvido por uma
  chamada anterior: é uma **retentativa idempotente**. Se `type`/`agent`/
  `data` (já normalizados) coincidirem com o que foi gravado, devolve a
  linha existente com `deduplicated: true`, sem gravar nada de novo — cobre o
  caso de a resposta da primeira chamada ter se perdido antes de chegar ao
  agente. Conteúdo diferente para o mesmo id é `CONFLICTING_ID`; id completo
  desconhecido é `UNKNOWN_ID` (só o servidor gera uuid, então um id
  completo nunca inventado pelo agente).

Marco aceita `milestoneType`, `target` (endereço no formato `hex:target:<id>`),
`count`, `dueAt`, `decisions[]` e `trace` (opcional). Veredito aceita `claim`,
`source`, `result`, `evidence`, `target` (também `hex:target:<id>`), `supersedes[]`,
`origin` e `trace`. `milestoneType: "gate"` e a chave `gate` são reservados ao
Marco que `evaluate_gate` grava; usá-los em `register` é `RESERVED_FIELD`.

No Marco, `trace` é ignorado na comparação de retentativa idempotente: reenviar
o mesmo id completo com `trace` diferente ainda deduplica (`deduplicated: true`).
No Veredito `trace` é obrigatório e entra normalmente na comparação.

### `evaluate_gate`

Avalia um gate contra um `target` e grava o resultado como um Marco de gate.
Gates **embutidos** (`no-orphans`, `no-conflicts`, `chain-intact`,
`no-invalid-references`, `no-forks`) são calculados pelo próprio servidor a
partir do Estado do processo, e não aceitam `result` informado pelo agente.
Gates **custom**, registrados via `register_gate` e fixados no processo,
exigem `result: {passed, evidence}` do agente.

`no-forks` reprova quando um Veredito superado tem 2 ou mais sucessores vivos
(2+ Vereditos que o citam em `supersedes` e não estão eles mesmos superados) —
um fan-out legítimo de um Veredito ainda vigente (Vereditos distintos, cada um
com seu próprio `claim`/`target`) não conta como fork.
Para resolver um fork, registre um Veredito que supere ramos em `supersedes`
até restar 1 sucessor vivo — superar só um dos dois ramos já basta.

O Marco de gate registrado **não abre nem fecha o ciclo** do alvo: avaliar
`no-orphans` sobre um Marco vencido não faz esse Marco deixar de aparecer em
`state.orphans`.

### `state`

Projeta o Estado atual do processo: Vereditos vigentes e em conflito, Marcos
órfãos (com `dueAt` vencido e sem evento posterior no mesmo alvo),
eventos a revisar, referências inválidas (`supersedes` apontando para um Veredito
inexistente), avisos de vocabulário, Vereditos com fork (`no-forks`, ver acima)
e a cadeia de hash. O parâmetro `sections` filtra o que volta na resposta; sem
ele, todas as seções voltam. Cada lista é cortada em 100 itens, e `totals` traz
o tamanho real de cada uma.

`targets` sempre volta na resposta, independente de `sections`: todo `target`
que algum Veredito já usou, inclusive os totalmente superados (sem nenhum
Veredito vigente). Com `withData: true` (padrão `false`), cada item de status
`active` em `active` ganha o `data` do Veredito vigente; itens de status
`conflict` (sem um vigente único) não ganham `data`. A resposta ainda respeita
o teto de `PAGE_CHARS_CAP = 24_000` caracteres: uma vez que o orçamento
estoura, os itens restantes vêm sem `data` e com `truncated: true`.

### `events`

Lista os eventos do log de um processo, em dois modos:

- **Modo cru** (sem `search`): ordem física do arquivo, a partir do índice
  físico `since`.
- **Modo busca** (com `search`, de 2 a 200 caracteres): constrói um índice de
  texto nesta própria chamada, só sobre os candidatos, e ordena por
  relevância decrescente. A consulta tenta `AND` primeiro; se não achar nada
  e tiver dois ou mais termos distintos, cai para `OR` — a resposta informa
  qual das duas (`combination`) foi usada.

Os dois modos aceitam os mesmos filtros por igualdade exata, combináveis com
`search` ou usados sozinhos: `type`, `target` (compara com `data.target`, campo
comum a Marco e Veredito), `milestoneType`, `result` e o intervalo
`[after, before)` de `timestamp`.

**A busca textual não encontra endereços `hex:target:<id>` nem ids de evento.**
Para filtrar por endereço, use o parâmetro `target` — não existe filtro por id
de evento.

`until` congela o prefixo do arquivo considerado (só as linhas físicas de
índice menor que `until`); sem informar, a chamada usa todas as linhas do
momento e devolve esse número em `until`. Como o arquivo é append-only, esse
prefixo nunca muda. Para paginar de forma estável, **reenvie o mesmo `until`**
recebido na primeira resposta e **use `nextCursor` como `since`** na
próxima chamada. Sem `until`, um `register` feito entre duas páginas pode
repetir ou omitir itens na fronteira — comportamento documentado, não erro.
`nextCursor` é `null` no fim (índice físico no modo cru; posição no
ranking no modo busca).

O teto por página é fixo em caracteres do JSON serializado
(`PAGE_CHARS_CAP = 24_000`), não em quantidade de eventos: cada linha entra
nesse orçamento pelo tamanho da sua serialização canônica (JCS), que varia
com os nomes de campo e o conteúdo de `data`. Por isso o número de páginas
para um mesmo corpus de eventos muda quando o formato em disco muda — por
exemplo, ao renomear campos —, mesmo com o teto de 24.000 caracteres
inalterado.

### `chain`

Verifica a sequência, o encadeamento de hash a partir da âncora fixada em
`process.json`, e a validade de `data` contra o schema fixado de cada tipo.
`breaks` e `repairedLines` vêm cortados em 100 itens, com os totais reais
à parte.

## Layout de dados

```
$XDG_DATA_HOME/hexlog/                 # 0700; fallback ~/.local/share/hexlog
  <project>/                           # 0700; criado pelo 1º register_* ou create_process
    schemas/<type>.json                # legado: fonte fixa da versão 1.0, nunca apagado/reescrito
    schemas/<type>/<major.minor>.json  # {name, schema, hash, registeredAt} — a partir de 1.1
    vocabulary/<owner>.json            # legado: fonte fixa da versão 1.0
    vocabulary/<owner>/<major.minor>.json  # {owner, milestoneType[], result[], action[], hash, registeredAt}
    gates/<gate>.json                  # legado: fonte fixa da versão 1.0
    gates/<gate>/<major.minor>.json    # {name, criteria, hash, registeredAt}
    <process>/                         # 0700
      process.json                     # manifesto fixado; criado só por create_process
      events.jsonl                     # 0600; 1 linha por evento
      events.jsonl.lock/holder         # transitório: lock mkdir + token
```

Um nome sem arquivo legado (registrado pela primeira vez já sob
versionamento) grava `1.0` direto no diretório — não existe `<nome>.json`
solto nesse caso. Um nome com legado nunca ganha um `1.0.json` dentro do
diretório: a versão `1.0` é sempre lida do arquivo solto, e o diretório, se
existir, começa em `1.1`.

`process.json` ganha um bloco opcional `versions` ({types, vocabulary,
gates}, cada um `Record<nome, versão>`) com a versão vigente de cada
definição no instante do `create_process`. Esse bloco fica **fora** do
cálculo de hash (`hashes`/`verifyHashes`) — por isso todo `process.json` já
gravado antes desta leva continua válido sem migração, e por isso também
`versions` é adulterável em disco sem disparar `PROCESS_CORRUPTED` (limitação
conhecida para quem cogitar usá-lo como trilha de auditoria).

A escrita de cada versão (`<nome>/<versão>.json`) é sempre exclusiva
(`linkSync`, nunca `writeJsonAtomic`): duas chamadas concorrentes no mesmo
alvo nunca produzem sucesso silencioso uma sobre a outra — a que perde a
corrida refaz a decisão inteira (vigente, `unchanged`, quebra, bump) contra
o que a vencedora acabou de gravar.

## Erros e avisos

Toda tool devolve um erro de domínio como `{code, message, details}`.
Alguns dos mais comuns:

| Código | Quando |
|---|---|
| `PROCESS_NOT_FOUND` | o processo informado não tem `process.json` |
| `INVALID_ID` / `UNKNOWN_ID` / `CONFLICTING_ID` | problemas de `id` em `register` |
| `TYPE_NOT_PINNED` | tipo custom fora do snapshot fixado do processo |
| `INVALID_EVENT` | `data` reprovado na validação, ou acima de 16.000 caracteres canônicos |
| `RESERVED_FIELD` | Marco com `milestoneType: "gate"` ou chave `gate` fora de `evaluate_gate` |
| `VOCABULARY_VIOLATED` | `milestoneType`/`decisions[].action` fora do vocabulário fixado (campo fechado); `details[0]` traz `owners` (donos de extensão fixados no processo) e `allowed` (termos que o campo de fato aceita, core ∪ extensões) |
| `INVALID_FILTER` | filtros de `events` inconsistentes (`milestoneType` fora do vocabulário, `after ≥ before`, `until` além do arquivo) |
| `GATE_NOT_REGISTERED` / `INVALID_EVALUATION` | problemas ao chamar `evaluate_gate` |
| `PROCESS_CORRUPTED` | `process.json` ilegível, ou hashes internos divergentes |
| `BREAKING_CHANGE` | `register_type`/`register_vocabulary`/`register_gate` com uma mudança que quebra, sem `breaking: true` no input |

Um aviso, diferente de erro, vem em `warnings[]` numa resposta de sucesso:

- `UNKNOWN_VOCABULARY` em `register`, quando `result` de um Veredito
  está fora do vocabulário conhecido (`result` é campo aberto: o evento é
  gravado normalmente, só o aviso muda).
- `NO_BREAKING_CHANGE` num `register_type`/`register_vocabulary`/`register_gate`
  com `breaking: true` cuja mudança, na verdade, não quebra — a versão bumpa
  minor mesmo assim, em vez de forçar major.
- `STALE_DEFINITIONS` em `create_process`, quando o `process` já existe e o
  snapshot fixado na criação diverge do candidato desta chamada (algo foi
  registrado no projeto depois) — `details: [{ section, name, pinned, current }]`
  lista o que mudou. `existed: true` de qualquer forma, com ou sem esse aviso.

## Lacunas de isolamento

O isolamento do hexlog combina 4 regras de deny (`Read`/`Edit` sobre o
diretório de dados, mais `Edit` sobre o artefato instalado) com um hook
PreToolUse na tool Bash que tokeniza o comando e nega quem alcançar o
diretório de dados. Esse hook sempre falha aberto: qualquer exceção interna,
Node ausente ou arquivo do hook apagado deixa o comando passar sem avisar o
agente — só o `--check` detecta essa condição.

Por desenho, isso deixa lacunas conhecidas, aceitas com a expectativa de que
o teste automatizado as marque como "passa":

| Lacuna | Exemplo |
|---|---|
| `cd` seguido de caminho relativo | `cd ~/.local/share && cat hexlog/p/r/events.jsonl` |
| `grep -r` no diretório pai | `grep -r foo ~/.local/share/` |
| Subprocessos | `node -e …`, `python -c …` |
| Grep/Glob tool do Claude Code apontando pro pai | `Grep path=~/.local/share` |
| Variável definida no mesmo comando | `d=~/.local/share; cat $d/hexlog/x` |
| ANSI-C quoting | `cat $'/home/…/hex\x6cog/x'` |
| Alternância de zsh | `cat ~/.local/share/(hexlog\|x)/p/r/events.jsonl` |
| Hook indisponível | Node removido pelo nvm, `~/.local/lib/hexlog/<versão>/` apagado à mão, ou instalação corrompida por fora |
| Alteração do artefato instalado por Bash/subprocesso | `cp x ~/.local/lib/hexlog/0.2.0/bash-guard.mjs`, `node -e "fs.writeFileSync(...)"` — o deny de `Edit` só cobre as tools Edit/Write/NotebookEdit, não Bash |
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
4. `rm -rf ~/.claude/skills/hexlog` — o instalador grava essa skill e nenhum
   dos passos acima a remove.

Os dados já registrados em `~/.local/share/hexlog` (ou no diretório apontado
por `XDG_DATA_HOME`) não são apagados por nenhum desses passos.

## Desenvolvimento

```sh
npm test          # jest: testa o código-fonte .ts diretamente
npm run typecheck # tsc --noEmit
npm run build     # esbuild, gera os bundles .mjs (equivalente ao passo 1 do instalador)
```

O jest testa o `.ts` fonte; os testes de ponta a ponta sobem o servidor a
partir do bundle já construído (`.mjs`), para cobrir o artefato que as
sessões de fato executam. Os testes do instalador substituem as execuções
externas (hook, servidor, `claude mcp`) por injeção, incluindo
`HEXLOG_REGISTER_MCP=<script>` para trocar `claude mcp add`/`remove` por um
script de teste sem depender do binário `claude` nem tocar no
`~/.claude.json` real.

## Links

- [ADR 0001: hexlog MVP](docs/adr-0001-hexlog-mvp.md)
- [Pesquisa de bibliotecas](docs/pesquisa/hexlog-pesquisa-libs.md)
