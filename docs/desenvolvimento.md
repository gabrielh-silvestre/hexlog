# Desenvolvimento

Comandos, scripts de leitura e testes. O resumo está no [README](../README.md).

```sh
npm test            # jest: testa o código-fonte .ts diretamente
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format:check
npm run build       # esbuild, gera os bundles .mjs (equivalente ao passo 1 do instalador)
```

Os specs de orçamento de tempo (`*.budget.spec.ts`) ficam fora do `npm test` e rodam
em série em `npm run test:budget`, no CI.

## Scripts de leitura

`scripts/insights.ts`, `scripts/export.ts`, `scripts/timeline.ts` e
`scripts/rdsc-projections.ts` são CLIs read-only, sem tool MCP correspondente: rodam direto com `node`, leem
`XDG_DATA_HOME` como as tools, não recebem o caminho do diretório de dados na
linha de comando e leem só por `src/compose.ts#composeReader`, o lado de leitura de
`compose`, que verifica a cadeia na leitura e não tem serviço de escrita. Nunca
importam `src/adapters/**` nem `src/mcp/**` e nunca escrevem no diretório de dados. A
tabela de exit codes dos quatro está em `scripts/AGENTS.md`; a regra é uma só: `2` é dado
quebrado (dado 0.x em `<D>`, `PROCESS_CORRUPTED` com cadeia adulterada ou `process.json`
ilegível, e anexo ausente ou adulterado em `timeline` e `insights`), `1` é o resto
(uso incorreto, erro, filtro sem resultado) e `0` é íntegro. Argumento desconhecido,
opção sem valor ou argumento a mais saem com o uso e `1`. O `rdsc-projections` é a
diferença deliberada: não decodifica o anexo (só o re-hash do blob), então anexo ausente ou
adulterado sai `0`.

**Exceção ao teto de saída.** Os scripts de leitura em `scripts/` (`insights`, `export`,
`timeline` e `rdsc-projections`) leem listas completas, numa consulta só e sem laço de
cursor; o teto de 64 MiB por processo limita a memória. É uma exceção ao princípio de
toda lista devolvida ter teto (`saidas-com-teto`, em
[estrategia.md](directives/estrategia.md)) e vale só para eles: as tools MCP seguem com
teto e dizem o que cortaram.

## `scripts/export.ts`

```sh
node scripts/export.ts <project>/<process> [--fields a,b,c]
```

Imprime em stdout uma linha JSON por registro do processo, vigentes ou não
(JSONL), com os campos de `QueryRecord` (`id`, `type`, `at`, `target`, `author`,
`data`, `in`, `out`, `needsReview`, `attachmentStatus`). Não emite `seq`, `prevHash`
nem `relations`: a relação sai como `in` e `out`. Com `--fields`, cada linha só traz
as chaves pedidas, e `seq`, `timestamp`, `agent` e `prevHash`, do 0.x, são recusados
como campo desconhecido. O processo sai numa consulta só, carregado inteiro em
memória (o teto de 64 MiB por processo limita o tamanho). Erro de uso (inclusive
`--fields` sem valor e flag desconhecida), processo inexistente e campo desconhecido
saem com `export failed: ...` em `stderr` e código `1`. A saída não escapa controles de
terminal (o `JSON.stringify` deixa C1 e bidi crus): é feita para pipe de máquina, e o
`timeline` é o script que escapa.

## `scripts/timeline.ts`

Consulta de alcance projeto com os registros não vigentes e as relações, sem teto de
página nem de texto por entrada: é o caminho para ler anexos grandes.

```sh
node scripts/timeline.ts <project> <target-prefix>... [--full] [--json] [--raw]
```

Cada argumento depois do projeto é um prefixo de target, com a fronteira de `.`. A
saída padrão é legível: uma seção `target <prefixo>: <n> records` por prefixo e um
bloco por registro, com as marcas `[superseded by <id>]` e `[revoked by <id>]` e as
relações de entrada e saída; não há linhas de cadeia (a leitura de alcance projeto já
falha fechada). `--full` imprime o texto de cada anexo íntegro entre
`----- attachment <hash> (<n> bytes) -----` e `----- end -----`. `--json` imprime
JSONL: uma linha `{"kind":"record", ...}` por registro, com o prefixo consultado em
`query` e, com `--full`, o texto dos anexos em `attachmentText`. O alcance projeto lê
todos os processos numa chamada só, e o teto de 64 MiB vale por processo: o consumo de
memória soma o projeto. Os avisos de anexo ausente ou adulterado vão para `stderr`.
Códigos de saída: `0` tudo íntegro; `2` cadeia ou `process.json` quebrado, anexo
ausente ou adulterado e dado 0.x; `1` uso incorreto ou erro (`timeline failed: CODE:
msg`).

**A saída escapa os controles de terminal por padrão.** O anexo e os campos livres
vêm de agentes e não são confiáveis, e um agente com prompt injetado grava o próprio
log, então a vítima é quem lê o terminal (a cadeia segue íntegra). Na string final, no
modo texto e no `--json`, `scripts/escape-controls.ts#escapeControls` troca C0 (menos LF
e TAB), DEL, C1 e os controles bidi por `\uXXXX` visível: ESC, CSI, OSC (por exemplo o
OSC 0 de título), U+009B e U+009D não chegam crus ao terminal, e o `JSON.parse` do
`--json` devolve o texto original. `--raw` imprime o byte exato (com `--full --raw` o
texto do anexo entre os delimitadores é idêntico ao anexo) e deixa o risco com quem lê.
Um anexo com a linha `----- end -----` ainda forja o delimitador no modo texto.

## `scripts/insights.ts`

```sh
node scripts/insights.ts [projeto[/processo]]
```

Relatório markdown de integridade da cadeia, linha do tempo e sinais da `key` (possível
duplicata sem chave, chave em excesso e percentual de lotes com chave por tipo) sobre
os registros do hexlog. Sai `2` com dado quebrado (cadeia ou anexo adulterado,
`process.json` ilegível, dado 0.x em `<D>`) e `1` com uso incorreto, falha de leitura de
um processo ou filtro sem resultado; com os dois no mesmo relatório vale o maior. Um
`process.json` ilegível não derruba o relatório: o processo sai marcado com
`insights failed: PROCESS_CORRUPTED` e os demais seguem. A chave em excesso é um proxy: o
reenvio com a mesma `key` devolve `replayed` sem gravar, então o log não registra
"nunca teve reenvio" (ADR 0009).

## `scripts/rdsc-projections.ts`

Snapshot de um processo em JSONL, para quem precisa do estado inteiro de uma vez: os
registros, o resultado de gates e o que mudou desde um marcador.

```sh
node scripts/rdsc-projections.ts <project> <process> \
  [--gate <name>]... [--gate-per-target <gate>:<regex>]... [--since <marker-json>]
```

Linhas, nesta ordem, cada uma um JSON por linha:

| `kind` | Quando | Chaves |
|---|---|---|
| `meta` | sempre, a primeira | `kind`, `project`, `process`, `head` (o id da cabeça do processo, `marker[process]`), `marker`, `version` (`1`) |
| `record` | um por registro, na ordem do log, vigentes ou não | `kind`, `id`, `type`, `at`, `target`, `author`, `current`, `data`, `in`, `out`, mais `needsReview` e `attachmentStatus` só quando o serviço os devolve |
| `gate` | cada `--gate` na ordem do argv (`target: null`), depois cada `--gate-per-target` | avaliado: `kind`, `gate`, `target`, `passed`, `questions` (`index`, `kind`, `passed`, `evidence`); erro: `kind`, `gate`, `error` |
| `changes` | só com `--since` | `kind`, `baseline`, `entered`, `left` |
| `end` | sempre, a última | `kind`, `records`, `gates` (linhas emitidas; as de erro de gate contam) |

**Comportamento.**

- `--gate-per-target <gate>:<regex>` separa no primeiro `:`. O regex (`new RegExp`, sem flags)
  vale para o rótulo, o primeiro segmento do `target` antes do primeiro `.`, dos registros
  vigentes; cada rótulo distinto gera uma avaliação com o rótulo como `target`. A ordem é a
  natural, `Intl.Collator('en', { numeric: true })` com desempate por unidade de código
  (`thing-2` antes de `thing-10`). Regex inválido ou `<gate>:<regex>` incompleto sai `1` com o
  uso. `--gate` repetido gera linhas repetidas, sem dedupe.
- Gate fora do manifesto do processo vira a linha `{"kind":"gate","gate":"<nome>","error":"GATE_NOT_FOUND"}`;
  gate com alguma pergunta de escopo `project` vira `PROJECT_SCOPE_UNSUPPORTED`, porque o
  marcador nomeia só este processo e o resto seria lido como vazio, em silêncio. As duas
  saem com exit `0` e uma linha só por gate, mesmo com `--gate-per-target`.
- `--since` aceita só um objeto com exatamente uma chave, o nome do processo, e valor
  `RecordId` ou `null`, por exemplo `'{"meu-processo":null}'`. JSON inválido, outra chave,
  chave extra ou valor errado saem `1` com o uso. Id presente no log (ou `null`) gera
  `baseline: true` com o que entrou e saiu desde ele; id que não existe no log do processo,
  inclusive de outro processo, gera `baseline: false` com `entered` e `left` vazios, exit `0`.
- **Consistência por `marker`.** O script lê o processo duas vezes, todos os registros e só os
  vigentes (`current` vem da segunda), e confere que o `marker` é o mesmo; se um `register`
  cai entre as duas, repete, até 3 tentativas. Esgotadas, sai `1` com `INTERNAL`
  (`marker changed on 3 consecutive reads`). Sob rajada de `register` isso é esperado, não
  defeito: rode de novo. O `evaluateGate` recebe o `marker` do `meta`.
- `attachmentStatus` é o estado do blob na hora da leitura e não acompanha o `marker`. O
  conteúdo do anexo não é decodificado nem impresso.
- **Custo.** A leitura carrega o processo inteiro em memória (vale aqui a exceção ao teto de saída
  descrita em "Scripts de leitura": `limit` máximo, sem cursor). Cada `evaluateGate`
  reverifica o log, então N rótulos de `--gate-per-target` custam N verificações do log, mais
  um `loadProcess` (carrega e verifica o log do processo) quando há algum gate. O
  `attachmentStatus` vem de um re-hash do blob (`adapters/fs/attachment-store.ts#statusOf`),
  feito nas duas leituras de cada tentativa.
- A saída é montada inteira em memória e escrita de uma vez, sempre terminando em `end`; em
  qualquer falha o stdout fica vazio e a falha sai em `stderr` como
  `rdsc-projections failed: CODE: msg`. Toda linha passa por `escapeControls`, então
  controles de terminal no `data` saem como `\uXXXX` e a linha segue JSON válido.

**Exit codes.** `0` íntegro, inclusive anexo ausente ou adulterado (o aviso fica no
`attachmentStatus`) e linhas de erro de gate; `1` uso incorreto, projeto ou processo
inexistente (`PROCESS_NOT_FOUND`: o script lê com escopo `process`, então não é
`PROJECT_NOT_FOUND` como no `timeline`) e `INTERNAL` na exaustão; `2` dado 0.x
(`LEGACY_DATA`), cadeia adulterada ou `process.json` ilegível (`PROCESS_CORRUPTED`).

**Dois arquivos.** `scripts/rdsc-projections-run.ts` exporta `run` e `parseRdscArgs` e não
tem efeito ao importar; `scripts/rdsc-projections.ts` só liga o `main`. Os scripts de leitura
terminam com `process.exitCode = main(...)` sem guarda, e o jest roda em CJS: importar o
entrypoint executaria o `main`. O módulo irmão deixa o spec chamar `run` com um leitor
injetado (o mesmo motivo de `scripts/escape-controls.ts` ser separado do `timeline.ts`).

## Testes

O jest testa o `.ts` fonte; os testes de ponta a ponta sobem o servidor a
partir do bundle já construído (`.mjs`), para cobrir o artefato que as
sessões de fato executam. Os testes do instalador substituem as execuções
externas (hook, servidor, `claude mcp`) por injeção, incluindo
`HEXLOG_REGISTER_MCP=<script>` para trocar `claude mcp add`/`remove` por um
script de teste sem depender do binário `claude` nem tocar no
`~/.claude.json` real. Os scripts de leitura rodam como processo real (`spawnSync`) contra
um `XDG_DATA_HOME` temporário; o `rdsc-projections` também importa
`scripts/rdsc-projections-run.ts` direto para provar a repetição das leituras com um
leitor roteirizado (`test/rdsc-projections-cli.spec.ts`).
