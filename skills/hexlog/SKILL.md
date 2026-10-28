---
name: hexlog
description: "Use when the agent needs to bootstrap a new project in hexlog (define types, relation names and gates, create a process, register records, evaluate gates) or to diagnose whether the installed hexlog server is healthy. Examples: bootstrap \"como funciona o modelo do hexlog?\"; diagnosis \"o hexlog está funcionando?\". Not for day-to-day registering or gate evaluation (hexlog-flow), nor for configuring the hexlog flow of a target repository (hexlog-setup)."
---

# hexlog

Servidor MCP para agentes registrarem o próprio histórico de trabalho: registros ligados por relações, num log append-only com cadeia de hash, e gates que respondem perguntas sobre esses registros. Esta skill cobre o modelo, o bootstrap de um projeto e o diagnóstico de saúde; a instalação está no `README.md` do repositório hexlog. O uso do dia a dia (registrar, buscar, avaliar) é da skill hexlog-flow. Para configurar o hexlog em um repositório novo (fases, tipos, gate e skill do projeto), use a skill hexlog-setup.

## O modelo em uma tela

- **O projeto define tudo.** O hexlog vem vazio de vocabulário, tipo e gate: o projeto define os tipos dos seus registros, os nomes das suas relações e os seus gates.
- **Registro** = `type` + `target` + `data` (validado pelo schema do tipo) + `relations`. O servidor atribui o `id` (`<process>:<uuid v7>`) e o agente usa o `id` devolvido. O `target` é um rótulo `a.b.c` (ver [`../hexlog-flow/references/target-format.md`](../hexlog-flow/references/target-format.md)).
- **Vigente**: um registro deixa de ser vigente quando outro o `supersedes` ou o `revokes`. Tudo que o hexlog responde (gates, `query`) olha só o vigente, salvo `includeNonCurrent`. Antes de `supersedes`/`revokes`, leia o vigente com a `query` e use o `id` devolvido; o passo a passo é da hexlog-flow.
- **Processo** = um log com a cadeia de hash. Ao ser criado, fixa a versão vigente de cada tipo, nome de relação e gate do projeto; a definição criada depois fica fora dele.
- **Anexo** = texto imutável endereçado pelo sha256. O registro o cita pelo hash num campo cujo schema tem `format: "attachment"`.

As 12 tools:

| Família | Tools |
|---|---|
| Definir (versões imutáveis do projeto) | `define_type`, `define_relation`, `define_gate` |
| Escrever | `create_process`, `register`, `attach` |
| Ler (`readOnlyHint`) | `list`, `describe_type`, `query`, `evaluate_gate`, `verify_chain`, `read_attachment` |

## Ordem obrigatória de bootstrap

| # | Tool | Motivo |
|---|---|---|
| 1 | `define_type`, `define_relation`, `define_gate` | Ao menos uma definição no projeto, e **todas** antes do passo 2. Projeto vazio de definições faz `create_process` recusar com `TYPE_NOT_FOUND` (`errors.ts#noDefinitions`) |
| 2 | `create_process` | Fixa as versões vigentes naquele instante e devolve os nomes em `pinned`, com `lineageInheritance: true` no processo novo. **Idempotente por nome**: chamar de novo devolve o processo existente com `created: false`, e `stale` lista o que mudou no projeto depois da fixação, sem fixar de novo. Para valer uma definição nova, crie um processo novo |
| 3 | `attach`, se o registro cita texto | O `register` exige o anexo já guardado |
| 4 | `register`, `evaluate_gate`, `query` | Dependem do processo do passo 2 |

Nomes de projeto, processo, tipo, relação e gate seguem `domain/ids.ts#Name`: minúsculo, `[a-z0-9-]`, começa com alfanumérico, até 63 caracteres.

**Nomeie `process` de release pelo que a release entrega (ex.: "release hextelemetry").** O processo é imutável: o nome pela versão ainda aberta (ex.: "release 0.0.2") deixa um processo órfão assim que a versão real diverge.

## Versão de definição e `breaking`

Cada `define_*` grava uma versão `major.minor` imutável. A mesma definição de novo é replay (`created: false`), exceto um tipo que carrega `pattern` ou `patternProperties`: esse é recusado (`INVALID_SCHEMA`), mesmo sendo a versão vigente. O servidor decide a quebra de tipo e de relação; a de gate é do agente:

| Definição | Compatível (minor) | Exige `breaking: true` |
|---|---|---|
| `define_type` | Acrescentar propriedade opcional ou valor de `enum` | Qualquer outra diferença: `required` novo, propriedade ou valor removido, `type` trocado, ou outra palavra-chave, inclusive `format`. Sem a flag: `BREAKING_CHANGE` (`errors.ts#breakingChange`) |
| `define_relation` | Alargar `from` ou `to` | Trocar `kind` ou estreitar as listas |
| `define_gate` | O servidor trata toda mudança como minor e deixa a quebra para o agente | **Você julga**: mande `breaking: true` quando a mudança aperta o gate, como pergunta nova ou seletor mais estreito em `approved` ou `occurred` |

`breaking: true` sempre sobe o major, mesmo que a mudança fosse compatível, exceto com definição idêntica à vigente (replay, `created: false`).

**Anexo e `breaking`.** Acrescentar `format: "attachment"` a um campo que já existia é quebra de tipo: a versão marcada se define com `breaking: true`. Por isso marque o campo na primeira versão do tipo; a skill hexlog-flow explica o que fazer quando um processo já ficou preso a um tipo sem a marca.

## Armadilhas

| Situação | Resultado | Onde |
|---|---|---|
| `create_process` com nome em `RESERVED_PROCESS_NAMES` (`types`, `relations`, `gates`, `attachments`, `archive`) | `RESERVED_NAME` | `domain/ids.ts#RESERVED_PROCESS_NAMES` |
| Qualquer tool com nome fora da regex `Name`, campo desconhecido, ou relação que omite `kind` e `as` | `INVALID_INPUT`: corrija o campo de `details[].path` e reenvie | a validação de entrada de cada tool |
| `define_type` com schema que é JSON Schema inválido, de raiz diferente de `"type": "object"`, ou com `$async`; `pattern` ou `patternProperties` em qualquer subschema (`pattern-not-allowed`: valide o formato com `format: "git-sha"` ou com `minLength`/`maxLength`); mais de 16.000 caracteres canônicos; `format: "attachment"` fora do primeiro nível | `INVALID_SCHEMA` | `commands/definition.ts#typeRule` |
| `define_*` com mudança que quebra e sem `breaking: true` | `BREAKING_CHANGE` | `errors.ts#breakingChange` |
| `register` com `type` fora do que o processo fixou (definido depois ou ausente do projeto) | `TYPE_NOT_PINNED` | `errors.ts#typeNotPinned` |
| `register` com `data` fora do schema fixado | `INVALID_RECORD`, com o `path` das violações de schema de cada registro do lote em `details` (`/records/<i>/data/...`; leia o schema antes com `describe_type`) | `commands/register/static.ts#checkData` |
| `evaluate_gate` com gate fora do conjunto que o processo fixou | `GATE_NOT_FOUND` | `errors.ts#gateNotFound` |
| Qualquer tool com dado 0.x ainda em `$XDG_DATA_HOME/hexlog` | `LEGACY_DATA` | só um humano resolve (ver abaixo) |

Notas:

- Para saber o que um processo congelou, chame `list` com `project` e `process`: devolve os nomes fixados (`pinned`), os hashes e `lineageInheritance: true` (processo novo; o processo antigo vem sem o campo). Com só `project`, devolve as definições vigentes e todas as suas versões.
- Para ler o schema de um tipo antes de registrar, chame `describe_type` com `project`, `type` e `process` (o tipo fixado, sem a versão na saída) ou sem `process` (a versão vigente ou uma pedida); `process` junto de uma versão pedida é `INVALID_INPUT`.
- O contrato completo de `query`, `evaluate_gate` e `register` (filtros, paginação, marcador, tetos) fica na descrição de cada tool.
- Os registros e as definições vivem em `<D>/.v1/`, com `<D>` = `$XDG_DATA_HOME/hexlog`. O hook de isolamento nega Bash que alcance `<D>`: leia só pelas tools.

## Exemplo mínimo: do zero a um `register` e um `evaluate_gate` verdes

```text
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
       lineageInheritance: true,
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
                     counts: { found: 1 } }],
       marker: { onboarding: "onboarding:<uuid v7>" } }
```

O gate responde sozinho a partir dos registros vigentes: o agente informa o alvo e deixa o `result` para o servidor. Por padrão a resposta traz só o tamanho de cada lista de evidência (`counts: {...}`) e, na pergunta reprovada, os ids que explicam a reprovação; `evidence: "full"` devolve todas as listas de ids, e `targets: [...]` avalia vários alvos numa chamada. Com `target` omitido, os seletores leem todos os alvos; com `target`, os seletores sem `targetPrefix` herdam esse alvo (a fronteira é o `.`).

## Diagnóstico de saúde

**Plataforma: só Linux.** O lock por pid, a gravação atômica e o arquivador dependem de /proc, de hard link e de fsync de diretório. macOS está por testar; Windows e FAT, exFAT e drvfs (/mnt/c no WSL) ficam fora.

**A prova real de que o servidor está vivo é chamar `list` sem parâmetros.** Ele responde os projetos e a contagem de processos de cada um, e funciona com o hexlog ainda vazio de projetos.

**`--check` prova só o hook e o manifest.** `node scripts/install.ts --check` valida o hook por execução real e compara o sha256 do manifest; a conexão ao MCP e a contagem de tools ficam fora dele. Essa garantia é herdada de `verifyPreparedArtifact` (`installation.ts#verifyPreparedArtifact`), chamada dentro de `installArtifact` (`installation.ts#installArtifact`) no momento da instalação, e a verificação roda só ali. Confundir os dois é o erro mais fácil de cometer: um `--check` verde fala apenas do hook e do manifest, e só o `list` prova o servidor MCP respondendo.

### O que exige a mão do humano

| Ação | Motivo técnico |
|---|---|
| Arquivar o dado 0.x (`node scripts/install.ts --archive-0x`, a partir do repositório hexlog) | Enquanto houver dado 0.x em `<D>`, toda tool responde `LEGACY_DATA`, com `details[0].code` `run` e o comando na mensagem. O agente roda `node scripts/install.ts` só com pedido explícito, porque o script escreve em `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/` |
| Destravar um processo com `LOCK_TIMEOUT` `holder-unreadable` | O dono do lock é ilegível e só o destravamento manual resolve. O diretório do lock (`<D>/.v1/<project>/<process>/records.jsonl.lock`) mora em `<D>`, fora do alcance do Bash do agente; o destravamento manual está em `docs/dados.md` do repositório hexlog |
| Descartar `$XDG_DATA_HOME/hexlog` | O hook PreToolUse nega qualquer Bash que alcance o diretório de dados — isolamento por desenho: respeite-o |
| Reiniciar a sessão do Claude Code | Cache de `tools/list` do protocolo MCP — fora do alcance de qualquer agente |

Reinstalar a mesma versão com conteúdo diferente segue adiante e só avisa "consider bumping the version".
