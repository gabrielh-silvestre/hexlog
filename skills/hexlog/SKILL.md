---
name: hexlog
description: "Use when the agent needs to bootstrap a new project in hexlog (define types, relation names and gates, create a process, register records, evaluate gates) or diagnose whether an already-installed hexlog server is healthy. Examples: \"configura o hexlog nesse projeto\", \"o hexlog está funcionando?\", \"registra esse marco no hexlog\", \"avalia esse gate\""
---

# hexlog

Servidor MCP para agentes registrarem o próprio histórico de trabalho: registros
ligados por relações, num log append-only com cadeia de hash, e gates que
respondem perguntas sobre esses registros. Esta skill cobre o modelo, o
bootstrap de um projeto e o diagnóstico de saúde — não a instalação; isso é do
`README.md` do repositório hexlog. O uso do dia a dia (registrar, buscar,
avaliar) é da skill hexlog-flow.

## O modelo em uma tela

- **Nada vem pronto.** Não há vocabulário, tipo ou gate embutido: o projeto
  define os tipos dos seus registros, os nomes das suas relações e os seus gates.
- **Registro** = `type` + `target` + `data` (validado pelo schema do tipo) +
  `relations`. O servidor atribui o `id` (`<process>:<uuid v7>`); o agente nunca
  o escolhe. O `target` é um rótulo `a.b.c` (ver
  [`../hexlog-flow/references/target-format.md`](../hexlog-flow/references/target-format.md)).
- **Vigente**: um registro deixa de ser vigente quando outro o `supersedes` ou o
  `revokes`. Tudo que o hexlog responde (gates, `query`) olha só o vigente, salvo
  `includeNonCurrent`. Antes de `supersedes`/`revokes`, leia o vigente com a
  `query` (`fields: []` lista só `id` e `target`) e use o `id` devolvido; o passo
  a passo está na hexlog-flow.
- **Processo** = um log com a cadeia de hash. Ao ser criado, fixa a versão
  vigente de cada tipo, nome de relação e gate do projeto; o que for definido
  depois não vale para ele.
- **Anexo** = texto imutável endereçado pelo sha256. O registro o cita pelo hash
  num campo cujo schema tem `format: "attachment"`.

As 12 tools:

| Família | Tools |
|---|---|
| Definir (versões imutáveis do projeto) | `define_type`, `define_relation`, `define_gate` |
| Escrever | `create_process`, `register`, `attach` |
| Ler (`readOnlyHint`) | `list`, `describe_type`, `query`, `evaluate_gate`, `verify_chain`, `read_attachment` |

## Ordem obrigatória de bootstrap

| # | Tool | Motivo |
|---|---|---|
| 1 | `define_type`, `define_relation`, `define_gate` | Ao menos uma definição no projeto, e **todas** antes do passo 2. Projeto sem nenhuma definição faz `create_process` recusar com `TYPE_NOT_FOUND` (`commands/process.ts#assertSomethingRegistered`) |
| 2 | `create_process` | Fixa as versões vigentes naquele instante e devolve os nomes em `pinned`. **Idempotente por nome**: chamar de novo devolve o processo existente com `created: false`, e `stale` lista o que mudou no projeto depois da fixação — não refixa. Para valer uma definição nova, crie um processo novo |
| 3 | `attach`, se o registro cita texto | O `register` exige o anexo já guardado |
| 4 | `register`, `evaluate_gate`, `query` | Dependem do processo do passo 2 |

Nomes de projeto, processo, tipo, relação e gate seguem `domain/ids.ts#Name`:
minúsculo, `[a-z0-9-]`, começa com alfanumérico, até 63 caracteres.

**Nomeie `process` de release por escopo, não por versão.** O processo é
imutável: nomear pela versão ainda não fechada (ex.: "release 0.0.2") deixa um
processo órfão assim que a versão real diverge; prefira o escopo (ex.:
"release hextelemetry").

**hexlog + ralplan.** Ao configurar hexlog num projeto que já roda ralplan,
escreva no `CLAUDE.md` desse projeto a regra "cada iteração do ralplan entra
no hexlog assim que acontece" — antes de disparar as iterações, não depois
que o usuário notar a lacuna.

## Versão de definição e `breaking`

Cada `define_*` grava uma versão `major.minor` imutável. A mesma definição de
novo é replay (`created: false`). O servidor decide a quebra de tipo e de
relação; a de gate é do agente:

| Definição | Compatível (minor) | Exige `breaking: true` |
|---|---|---|
| `define_type` | Acrescentar propriedade opcional ou valor de `enum` | Qualquer outra diferença: `required` novo, propriedade ou valor removido, `type` trocado, ou outra palavra-chave, inclusive `format`. Sem a flag: `BREAKING_CHANGE` (`commands/definition.ts#targetVersion`) |
| `define_relation` | Alargar `from` ou `to` | Trocar `kind` ou estreitar as listas |
| `define_gate` | Toda mudança é minor: o servidor não detecta quebra | **Você julga**: mande `breaking: true` quando a mudança aperta o gate, como pergunta nova ou seletor mais estreito em `approved` ou `occurred` |

`breaking: true` sempre sobe o major, mesmo que a mudança fosse compatível, exceto
com definição idêntica à vigente (replay, `created: false`).

**Anexo e `breaking`.** Acrescentar `format: "attachment"` a um campo que já
existia é quebra de tipo: a versão marcada se define com `breaking: true`. Por
isso marque o campo na primeira versão do tipo; a skill hexlog-flow explica o que
fazer quando um processo já ficou preso a um tipo sem a marca.

## Armadilhas

| Situação | Resultado | Onde |
|---|---|---|
| `create_process` com nome em `RESERVED_PROCESS_NAMES` (`types`, `relations`, `gates`, `attachments`, `archive`) | `RESERVED_NAME` | `domain/ids.ts#RESERVED_PROCESS_NAMES` |
| Qualquer tool com nome fora da regex `Name`, campo desconhecido, ou relação sem `kind` nem `as` | `INVALID_INPUT`: corrija o campo de `details[].path` e reenvie | a validação de entrada de cada tool |
| `define_type` com schema que não é JSON Schema válido, de raiz diferente de `"type": "object"`, ou com `$async`; `pattern` sem `maxLength` de até 256; `patternProperties` sem `propertyNames.maxLength` de até 256; regex que a `safe-regex2` recusa (inclusive `^[a-z]+(?:-[a-z]+)*$`); mais de 16.000 caracteres canônicos; `format: "attachment"` fora do primeiro nível | `INVALID_SCHEMA` | `commands/definition.ts#typeRule` |
| `define_*` com mudança que quebra e sem `breaking: true` | `BREAKING_CHANGE` | `commands/definition.ts#targetVersion` |
| `register` com `type` fora do que o processo fixou (definido depois, ou nunca) | `TYPE_NOT_PINNED` | `commands/register/static.ts#pinnedSchema` |
| `register` com `data` fora do schema fixado | `INVALID_RECORD`, com o `path` da primeira violação de schema de cada registro do lote em `details` (`/records/<i>/data/...`; leia o schema antes com `describe_type`) | `commands/register/static.ts#checkData` |
| `evaluate_gate` com gate que o processo não fixou | `GATE_NOT_FOUND` | `queries/query-service.ts#gateNotFound` |
| Qualquer tool com dado 0.x ainda em `$XDG_DATA_HOME/hexlog` | `LEGACY_DATA` | só um humano resolve (ver abaixo) |

Notas:

- Para saber o que um processo congelou, chame `list` com `project` e
  `process`: devolve os nomes fixados (`pinned`) e os hashes. Com só `project`,
  devolve as definições vigentes e todas as suas versões.
- Para ler o schema de um tipo antes de registrar, chame `describe_type` com `project`,
  `type` e `process` (o tipo fixado, sem a versão na saída) ou sem `process` (a versão
  vigente ou uma pedida); `process` junto de uma versão pedida é `INVALID_INPUT`.
- O contrato completo de `query`, `evaluate_gate` e `register` (filtros,
  paginação, marcador, tetos) está na descrição de cada tool; esta skill não o
  repete.
- Os registros e as definições vivem em `<D>/.v1/`, com `<D>` =
  `$XDG_DATA_HOME/hexlog`. O hook de isolamento nega Bash que alcance `<D>`:
  leia só pelas tools.

## Exemplo mínimo: do zero a um `register` e um `evaluate_gate` verdes

```
1. define_type({
     project: "myproj", name: "note",
     schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
   })
   → { name: "note", version: "1.0", hash: "<sha256>", created: true }

2. define_gate({
     project: "myproj", name: "has-note",
     questions: [{ kind: "occurred", select: { type: "note" } }]
   })
   → { name: "has-note", version: "1.0", hash: "<sha256>", created: true }

3. create_process({ project: "myproj", process: "onboarding" })
   → { project: "myproj", process: "onboarding", created: true,
       pinned: { types: ["note"], relations: [], gates: ["has-note"] } }

4. register({
     project: "myproj", process: "onboarding", agent: "setup-agent",
     key: "onboarding-first-note",
     records: [{ type: "note", target: "onboarding.step-1", data: { text: "done" } }]
   })
   → { records: [{ id: "onboarding:<uuid v7>" }], replayed: false,
       marker: { onboarding: "onboarding:<uuid v7>" } }

5. evaluate_gate({
     project: "myproj", process: "onboarding", gate: "has-note", target: "onboarding"
   })
   → { passed: true,
       questions: [{ index: 0, kind: "occurred", passed: true,
                     evidence: { found: ["onboarding:<uuid v7>"] } }],
       marker: { onboarding: "onboarding:<uuid v7>" } }
```

O gate responde sozinho a partir dos registros vigentes: o agente não informa
`result`. Com `target` omitido, os seletores leem todos os alvos; com `target`,
os seletores sem `targetPrefix` herdam esse alvo (a fronteira é o `.`).

## Diagnóstico de saúde

**Plataforma: só Linux.** O lock por pid, a gravação atômica e o arquivador dependem de /proc, de
hard link e de fsync de diretório. macOS não foi testado; Windows e FAT, exFAT e drvfs (/mnt/c no
WSL) ficam fora.

**A prova real de que o servidor está vivo é chamar `list` sem parâmetros.**
Ele responde os projetos e a contagem de processos de cada um, sem precisar de
nenhum projeto existente.

**`--check` não prova o servidor.** `node scripts/install.ts --check` valida
o hook por execução real e compara o sha256 do manifest — mas nunca conecta
ao MCP nem reconfere a contagem de tools. Essa garantia é herdada de
`verifyPreparedArtifact` (`installation.ts#verifyPreparedArtifact`), chamada
dentro de `installArtifact` (`installation.ts#installArtifact`) no momento da
instalação, e não é reverificada depois. Confundir os dois é o erro mais fácil
de cometer: um `--check` verde não diz nada sobre o servidor MCP responder.

### O que exige a mão do humano

| Ação | Motivo técnico |
|---|---|
| Arquivar o dado 0.x (`node scripts/install.ts --archive-0x`, a partir do repositório hexlog) | Enquanto houver dado 0.x em `<D>`, toda tool responde `LEGACY_DATA`, com `details[0].code` `run` e o comando na mensagem. O agente não roda `node scripts/install.ts` sem pedido explícito: escreve em `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/` |
| Destravar um processo com `LOCK_TIMEOUT` `holder-unreadable` | O dono do lock não pode ser lido, e repetir nunca resolve. O diretório do lock (`<D>/.v1/<project>/<process>/records.jsonl.lock`) mora em `<D>`, fora do alcance do Bash do agente; o destravamento manual está em `docs/dados.md` do repositório hexlog |
| Descartar `$XDG_DATA_HOME/hexlog` | O hook PreToolUse nega qualquer Bash que alcance o diretório de dados — isolamento por desenho, não um obstáculo a contornar |
| Reiniciar a sessão do Claude Code | Cache de `tools/list` do protocolo MCP — fora do alcance de qualquer agente |

Reinstalar a mesma versão com conteúdo diferente **não bloqueia** — só avisa
"consider bumping the version".
