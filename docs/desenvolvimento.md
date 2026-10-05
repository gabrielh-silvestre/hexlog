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

`scripts/insights.ts`, `scripts/export.ts` e `scripts/timeline.ts` são CLIs
read-only, sem tool MCP correspondente: rodam direto com `node`, leem
`XDG_DATA_HOME` como as tools, não recebem o caminho do diretório de dados na
linha de comando e leem só por `src/compose.ts#composeReader`, o lado de leitura de
`compose`, que verifica a cadeia na leitura e não tem serviço de escrita. Nunca
importam `src/adapters/**` nem `src/mcp/**` e nunca escrevem no diretório de dados. A
tabela de exit codes dos três está em `scripts/AGENTS.md`; a regra é uma só: `2` é dado
quebrado (dado 0.x em `<D>`, `PROCESS_CORRUPTED` com cadeia adulterada ou `process.json`
ilegível, e anexo ausente ou adulterado em `timeline` e `insights`), `1` é o resto
(uso incorreto, erro, filtro sem resultado) e `0` é íntegro. Argumento desconhecido,
opção sem valor ou argumento a mais saem com o uso e `1`.

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

## Testes

O jest testa o `.ts` fonte; os testes de ponta a ponta sobem o servidor a
partir do bundle já construído (`.mjs`), para cobrir o artefato que as
sessões de fato executam. Os testes do instalador substituem as execuções
externas (hook, servidor, `claude mcp`) por injeção, incluindo
`HEXLOG_REGISTER_MCP=<script>` para trocar `claude mcp add`/`remove` por um
script de teste sem depender do binário `claude` nem tocar no
`~/.claude.json` real.
