# Dados, erros e isolamento

Layout em disco, erros e avisos, tetos do lock, recuperação e lacunas de isolamento.

## Layout de dados

Os dados ficam em `<D>`, que é `$XDG_DATA_HOME/hexlog/`. Se `XDG_DATA_HOME` estiver ausente,
vazia ou não for um caminho absoluto, `<D>` cai em `~/.local/share/hexlog`
(`src/directory.ts#dataDir`). `<D>` precisa de um sistema de arquivos com hard link e semântica
POSIX (`rename` e `link` atômicos).

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
- **`records.jsonl`** é append-only. Cada linha é um lote `{"links":[...]}` de 1 a 50 elos,
  um por registro; cada elo é o registro mais `seq` (contíguo, por processo) e `prevHash`, e só
  o primeiro elo do lote carrega `batch` (impressão do lote, `key` e apelidos). O hash de um
  elo é `sha256(prevHash + JCS(elo sem prevHash))` (JCS, RFC 8785;
  `src/domain/chain.ts#hashLink`), e o `prevHash` do primeiro elo é a âncora. A linha é
  enquadrada por `src/shared/loader.ts#formatLine`. Não existe tool nem função que
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
| `INVALID_FILTER` | filtro da `query` inconsistente: `process` ausente no alcance processo (`required`) ou `text` sem termo pesquisável (`no-terms`: espaço e pontuação não são termos). `text` acima de 200 caracteres e `limit` fora de 1 a 200 saem como `INVALID_INPUT`, porque o zod da tool barra antes; `too-long` e `out-of-range` só saem pelo serviço, nos scripts |
| `INVALID_CURSOR` / `MARKER_NOT_FOUND` | `cursor`, `changesSince` ou `marker` que não batem com o dado lido. `INVALID_CURSOR`: `malformed`, `too-long`, campo do cursor inválido, `scope-mismatch`, `project-mismatch`, `process-mismatch`, `filters-mismatch`, `marker-hash-mismatch` ou `last-id-not-found`, e a mensagem manda reexecutar a consulta sem `cursor`. `MARKER_NOT_FOUND`: `marker-not-found` (o id não está no log do processo) ou `process-not-found` (o marcador nomeia processo inexistente ou não lido); os dois levam `process`, o processo cujo marcador falhou |
| `RESERVED_NAME` | nome de processo reservado |
| `INVALID_SCHEMA` | schema de tipo que o `ajv` recusa, `$async`, raiz diferente de `object`, `pattern` sem `maxLength` até 256, `patternProperties` sem `propertyNames.maxLength`, regex recusada pela `safe-regex2` ou marca `attachment` fora do primeiro nível (`path` `.../format`) |
| `BREAKING_CHANGE` | `define_*` com mudança que quebra, sem `breaking: true` |
| `PROJECT_NOT_FOUND` / `PROCESS_NOT_FOUND` | projeto ou processo inexistente |
| `TYPE_NOT_FOUND` / `GATE_NOT_FOUND` / `RELATION_NOT_FOUND` | `TYPE_NOT_FOUND`: `create_process` em projeto sem nenhuma definição (`/project`, `unknown-name`). `GATE_NOT_FOUND`: gate não fixado no processo (`/gate`). `RELATION_NOT_FOUND`: destino de relação que não existe (`missing`) ou de processo com cadeia quebrada ou manifesto ilegível (`destination-corrupted`, com `process`). Nenhuma tool recebe versão, então `unknown-version` não sai por tool |
| `TYPE_NOT_PINNED` | tipo que o processo não fixou |
| `INVALID_RECORD` | `data` reprovado pelo schema, ou relação que viola uma regra (item, relação e regra no `path`) |
| `FORK_REJECTED` | `supersedes` ou `revokes` sobre registro que já não é vigente (`current` traz a versão atual, ou `null`) |
| `CYCLE_REJECTED` | relação que fecharia um ciclo |
| `IDEMPOTENCY_CONFLICT` | mesma `key` com outro lote |
| `ATTACHMENT_NOT_FOUND` / `ATTACHMENT_CORRUPTED` | o blob não existe, ou o sha256 dos bytes não bate com o nome: `details` traz `/hash` com `not-found` ou `corrupted`, e no `register` o `path` do campo de `data` |
| `PROCESS_CORRUPTED` | cadeia quebrada (`broken-chain`) ou `process.json` ilegível (`unreadable-manifest`), com o processo em `details[0].process`; ver "Recuperar um processo corrompido" |
| `PROCESS_TOO_LARGE` | `records.jsonl` no teto de 64 MiB, na escrita e também na leitura (do próprio processo ou de um destino de relação): `details[0]` é `{path: '/process', code: 'too-large', process}`. Só a escrita do próprio processo do `register` manda criar um processo novo; na leitura e no destino a mensagem é neutra |
| `LOCK_TIMEOUT` | `lock-busy` (dono vivo por mais de 15 s, com o `pid`), `lock-lost` (o lock foi perdido antes da gravação) ou `holder-unreadable` (a mensagem manda pedir ao usuário que remova o lock); ver abaixo |
| `LEGACY_DATA` | há dado 0.x em `<D>`; ver [Dado 0.x: arquivamento](migracao.md#dado-0x-arquivamento---archive-0x) |
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
   servidor hexlog (reuso de pid), apague o lock. Ele é um diretório com só o `holder`
   dentro (`src/adapters/fs/lock.ts#tryCreate`), então confira o alvo e apague em
   passos separados, sem `rm -r`:

   ```sh
   D=${XDG_DATA_HOME:-$HOME/.local/share}/hexlog
   L="$D/.v1/<projeto>/<processo>/records.jsonl.lock"   # troque <projeto> e <processo>
   ls -d "$L"        # confere o alvo antes de apagar
   rm "$L/holder"
   rmdir "$L"        # falha se sobrou algo além do holder: pare e confira
   ```

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
em [Verificação](instalacao.md#verificação---check).

**Falsos positivos aceitos** (o guard nega um comando inofensivo): um comando
que só cita o diretório de dados literalmente, como
`git commit -m "… ~/.local/share/hexlog …"`; um caminho entre aspas duplas
que o shell não expande mas o hook trata como caminho; e um `**` ou uma chave
`{a,b}` com barra cujo prefixo literal é ancestral do diretório de dados,
como `ls ~/**/*.md` ou `ls ~/{docs/a,b}`. Um `**` dentro de outros
repositórios (por exemplo `/caminho/do/repo/**/*.ts`) não é afetado, porque
o prefixo não é ancestral do diretório de dados.

**`<D>` é confiável.** Só o servidor escreve em `<D>/.v1/`, e o hook de Bash bloqueia o agente;
por isso os stores não se endurecem contra objeto plantado ali. O servidor segue symlink, e um
FIFO no lugar de um arquivo trava o servidor, que tem uma thread só, sem erro nem timeout. Quem
planta link ou FIFO em `<D>` é o mesmo usuário, que já pode reescrever o `records.jsonl`,
porque a cadeia sha256 não tem chave.

**Restauro de `<D>`:** por cópia, sem link (`cp -a`, `rsync -a`). Hard link (`cp -al`,
`--link-dest`) não é coberto nem por `O_NOFOLLOW`. A decisão está no item 9 do
[ADR 0009](adr-0009-ferramental.md).
