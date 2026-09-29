# ADR 0005: Skills hexlog-setup e hexlog-flow

**Status:** Aceito (emendado em 2026-09-28, ver [Amendment](#amendment-2026-09-28) no fim deste arquivo; invalida partes de Decision, Drivers, Alternatives Considered e Consequences; emendado de novo em 2026-09-29, ver [Amendment](#amendment-2026-09-29), sobre o invariante das dez tools)

**Data:** 2026-09-27

**Deciders:** Gabriel Henrique Silvestre Baldino; grilling e planejamento RALPLAN "hexlog-setup-flow-skills" (consenso na iteração 4)

---

## Context

O hexlog registra estrutura — marcos, veredictos, gates — mas nenhuma definição
carrega semântica sobre o fluxo pré-código de um projeto: por que existem
aquelas fases, o que cada uma decide, quais skills ou tools do repo alvo
alimentam cada fase. Sem esse mapa, configurar o hexlog num novo repositório
exigia refazer manualmente, a cada vez, a extração de fases, vocabulário e
gates a partir das skills e tools já em uso, e não havia forma consistente de
lembrar um agente de cruzar informação no momento certo do fluxo.

A skill `hexlog` existente (`skills/hexlog/SKILL.md`) cobre bootstrap genérico
e diagnóstico de saúde do servidor, mas não guia a extração desse mapa nem o
cruzamento contínuo contra o Estado do processo. O escopo desta decisão é
configuração (mapear o fluxo uma vez) mais operação (registrar e cruzar no
dia a dia); manutenção e reconfiguração do mapa ficam de fora — a
`hexlog-setup` recusa rodar se `.hexlog/flow.md` já existir.

## Decision

Duas skills novas entram em `skills/`: `hexlog-setup` (facilitadora, roda uma
vez por repositório) e `hexlog-flow` (registro e cruzamento do dia a dia). A
skill `hexlog` continua só com a mecânica de bootstrap/diagnóstico.

O mapa do fluxo vive em `.hexlog/flow.md`, no repositório alvo — não no
servidor MCP. O arquivo tem frontmatter YAML (fases, processo por fase,
skills mapeadas por fase, bloco `versions`, padrão do `<id>` de target, gate
custom por fase, flag `hook`, array `editedSkills`) validado por um schema
Zod novo, `FlowMap` (`src/flow-map.ts`), e corpo markdown livre com a
semântica que o servidor não guarda. A função `parseFlowMap` extrai o bloco
entre os delimitadores `---`, faz o parse com o pacote `yaml` (promovido de
dependência transitiva, via `lint-staged`, a dependência direta, versão exata
`2.9.1` — sem `^`/`~`, mesmo padrão do restante do `package.json`) e valida
com Zod, sem tocar `errors.ts` nem o catálogo de `ErrorCode`: não é resposta
de tool MCP.

A `hexlog-setup` entrevista o usuário uma pergunta por vez, lê as
skills/tools que ele aponta na descoberta, extrai pontos de decisão, propõe
um plano de chamadas (`register_vocabulary`/`register_type`/`register_gate`/
`create_process`), espera a aprovação explícita e só então registra e grava
`.hexlog/flow.md`. Convenção fixada: `owner` do vocabulário é o nome do
projeto, `agent` é o nome da skill que disparou o registro. A setup também
garante o ponteiro no `AGENTS.md` do repositório alvo (cria se ausente;
propõe `@AGENTS.md` no `CLAUDE.md` se este não importar o primeiro, sempre
com aprovação antes de escrever).

Acionamento tem dois opcionais independentes, oferecidos no mesmo turno de
aprovação: (a) editar, uma de cada vez e com diff aprovado antes de gravar,
cada skill apontada na descoberta para que ela chame a `hexlog-flow` no ponto
de decisão já extraído — toda skill efetivamente editada entra em
`editedSkills`; (b) ativar um hook `PostToolUse` em `Skill`,
`hook/flow-reminder.ts`, que só lembra e nunca bloqueia. O hook faz quatro
checagens estritamente locais sobre o payload — `.hexlog/flow.md` existe a
partir do `cwd`, o frontmatter valida contra `FlowMap`, a flag `hook` está
ativada, o nome da skill invocada está mapeado em alguma fase — e só emite
`hookSpecificOutput.additionalContext` quando as quatro são verdadeiras;
qualquer não ou exceção interna cai em exit 0 sem stdout, a mesma garantia de
falha aberta que `hook/bash-guard.ts` já usa (R-1). Nunca acessa o servidor
nem o `dataDir`: cruzamento de verdade é responsabilidade exclusiva da
`hexlog-flow`, chamada via MCP. O mesmo bundle também aceita
`--validate <caminho>`, reaproveitado pela `hexlog-setup` para autoconferir o
`.hexlog/flow.md` recém-escrito sem precisar de uma tool nova.

A ativação do hook é sempre por repositório e opcional: a instalação padrão
do harness (`~/.claude/settings.json`) não muda. O instalador grava o bundle
buildado em `~/.local/lib/hexlog/<versão>/flow-reminder.mjs` (mesmo padrão
versionado dos outros dois artefatos) e, adicionalmente, uma cópia estável em
`~/.local/lib/hexlog/flow-reminder.mjs` fora do diretório de versão; a
entrada que a `hexlog-setup` escreve no `.claude/settings.json` do repositório
alvo referencia essa cópia estável
(`node "$HOME/.local/lib/hexlog/flow-reminder.mjs"`), portável e que sobrevive
a upgrades sem exigir que o repositório alvo saiba qual versão do hexlog está
instalada.

O instalador deixa de copiar uma única skill fixa: passa a iterar todas as
pastas de `skills/` (`fs.readdirSync` filtrando diretórios) e copiar cada uma
por inteiro, `SKILL.md` mais `references/`, com `fs.cpSync`. `--check`
confere cada pasta individualmente, reportando o nome exato de qualquer uma
que falte. `Bundles` (`src/installation.ts`) ganha um terceiro campo fixo,
`flowReminder: Buffer`, ao lado de `server` e `hook` — não um mapa genérico.

## Drivers

- O servidor guarda estrutura sem semântica: nenhuma definição tem campo de
  descrição, e criar um teria custo maior (schema novo, migração) do que
  colocar a semântica num arquivo do repositório alvo.
- Exatamente 10 tools MCP é invariante do projeto desde o ADR 0001 — nenhuma
  solução que exigisse uma tool nova (ler, validar ou versionar o flow map)
  era aceitável.
- Escopo v1 é configuração mais operação; manutenção e reconfiguração do
  mapa ficam fora, mantendo o diff pequeno e o comportamento da `hexlog-setup`
  previsível (recusa se o mapa já existe, em vez de tentar mesclar).
- O padrão de versionamento/guard/build já testado (ADR 0002) cobre a
  extensão para um terceiro artefato e para N pastas de skill sem introduzir
  mecanismo novo — generalizar o que já existe custa menos que inventar.

## Alternatives Considered

- **Mapa de fluxo guardado no servidor (tipo ou tool nova)** — rejeitada:
  qualquer forma de persistir semântica ali exigiria uma tool nova ou um
  campo de descrição no schema de definições, quebrando o invariante de 10
  tools herdado do ADR 0001.
- **Hook bloqueante, no padrão de `hook/bash-guard.ts`** — rejeitada: a
  decisão do usuário é que o novo hook só lembra; um hook que bloqueia
  contradiria essa premissa e criaria um segundo caminho de fricção
  incompatível com "opcional e por repositório".
- **Duplicar `test/skill-coherence.spec.ts` por skill** — rejeitada: os
  catálogos que o spec confere (`ErrorCode`, constantes
  `SCREAMING_SNAKE_CASE`, `FIELD_NAME_ALLOWLIST`) pertencem ao projeto, não a
  uma skill específica; parametrizar com `describe.each` evita boilerplate
  triplicado sem perder cobertura por skill.
- **`Bundles` genérico, `Record<string, Buffer>`** — rejeitada por ora: só
  dois artefatos existiam antes desta mudança, e nenhum mapa de decisão
  previa um quarto; generalizar para N é abstração especulativa fora do
  escopo v1 (ladder do ponytail — YAGNI antes de reuso). **Critério objetivo
  de reversão:** se um próximo artefato exigir um quarto campo em `Bundles`,
  migrar para `Record<string, Buffer>` é obrigatório no mesmo PR que
  introduz esse artefato — não fica em aberto para "quando doer".
- **Materializar a cópia estável do hook por cópia lazy, no primeiro
  `--check`** — rejeitada: adiciona um caminho de escrita condicional a mais
  para economizar uma cópia de arquivo que o instalador já faz de rotina a
  cada versão nova.

## Why chosen

Esta é a combinação de menor diff que fecha as decisões já tomadas com o
usuário (ver
`.omc/wiki/skills-hexlog-setup-e-hexlog-flow-mapa-do-fluxo-pr-c-digo-vive-e.md`),
reaproveitando por completo o padrão de
versionamento/guard/build que o ADR 0002 já testou — generalizar `Bundles` e
a cópia de skills é o mesmo tipo de extensão que aquele ADR fez em
`process.json`/`FixedVersions`, não um mecanismo novo. Adiar a generalização
de `Bundles` para `Record<string, Buffer>` até haver um quarto artefato real
evita pagar o custo de uma abstração que hoje só teria um caso de uso
hipotético.

## Consequences

- O instalador cresce de dois para três bundles e de uma skill fixa para N
  pastas: todo teste que hardcodeava "dois bundles" ou "a skill hexlog"
  precisou mudar (`test/guard.spec.ts`, `test/toolchain.spec.ts`,
  `test/skill-coherence.spec.ts`).
- `.hexlog/flow.md` é escrita ativa do repositório alvo, fora do controle de
  versão do hexlog em si: não há migração automática se o schema de
  `FlowMap` mudar no futuro — mesma filosofia do ADR 0002 (nada é migrado
  por baixo do usuário).
- A ativação do hook `flow-reminder` é sempre por repositório e opcional,
  nunca parte da instalação padrão do harness; removê-la é editar ou apagar
  a entrada correspondente em `.claude/settings.json` do repositório alvo,
  sem efeito colateral em nenhum outro projeto.
- A cópia estável em `~/.local/lib/hexlog/flow-reminder.mjs` (fora do
  diretório de versão) passa a ser mais uma superfície que o instalador
  mantém sincronizada a cada troca de versão, ao lado do próprio diretório
  versionado.
- Fadiga de alerta é um risco aceito e não eliminado: o hook não cruza
  informação (não tem canal para o servidor), então não existe sinal de "há
  algo real para cruzar" que condicione o lembrete — toda invocação de uma
  skill mapeada, num repositório com `hook: true`, dispara o lembrete,
  mesmo quando a `hexlog-flow` acabou de ser chamada corretamente. A
  mitigação parcial é restringir o lembrete às skills de fato mapeadas no
  frontmatter e manter o texto do lembrete curto; a saída, se a fadiga for
  real na prática, é o usuário remover a entrada do hook — não há follow-up
  de código para "silenciar melhor" dentro do escopo v1.

## Amendment (2026-09-28)

Por decisão do usuário, o hook `hook/flow-reminder.ts` foi retirado do v1
antes do merge do PR #32. Motivo: `.hexlog/flow.md` não tinha nenhum
consumidor programático além do hook em si — o único outro leitor é o agente
da skill `hexlog-flow`, que lê o arquivo como texto, sem parser. Sem
consumidor programático, o schema Zod `FlowMap` e o parser `parseFlowMap`
(`src/flow-map.ts`) saem junto: `skills/hexlog-setup/references/flow-map-schema.md`
vira a especificação autônoma do frontmatter, sem validador de código por
trás. O terceiro artefato/bundle (`flowReminder` em `Bundles`,
`src/installation.ts`), a cópia estável fora do diretório de versão
(`~/.local/lib/hexlog/flow-reminder.mjs`) e o modo `--validate` do bundle
saem do instalador — que volta a copiar dois bundles (`server`, `bash-guard`).
A dependência `yaml`, promovida a direta só para `flow-map.ts`, volta a
transitiva (via `lint-staged`).

Isso invalida, no texto acima, tudo que descreve o hook, o terceiro bundle e
`FlowMap`/`parseFlowMap` como decisão vigente (Decision, Drivers,
Alternatives Considered, Consequences) — mantido como registro histórico do
que foi decidido e depois revertido, não como estado atual do código.
`editedSkills` continua vigente: é o único opcional que sobra do "Acionamento
tem dois opcionais independentes" do Decision original.

Volta a existir schema/validador de código para `FlowMap` quando surgir o
primeiro consumidor programático de `.hexlog/flow.md` — não antes.

## Amendment (2026-09-29)

O [ADR 0006](adr-0006-anexos-tipos-timeline.md) acrescenta as tools
`attachment` e `timeline` e passa o servidor a 12 tools. Isso invalida, no
texto acima, o invariante das dez tools MCP dos Drivers como
restrição vigente; o resto da decisão (as duas skills e o mapa
`.hexlog/flow.md`) segue de pé. A skill `hexlog-flow` foi corrigida e
ampliada por aquele ADR (registro de desvio e racional, `timeline`).
Mantido o corpo como registro histórico do que valia em 2026-09-27.

## Follow-ups

- V2 cobre manutenção e reconfiguração do flow map; hoje a `hexlog-setup` só
  recusa quando `.hexlog/flow.md` já existe.
- O critério de reversão de `Bundles` para `Record<string, Buffer>` está
  registrado acima, em "Alternatives Considered" — não é um follow-up em
  aberto, é uma obrigação condicionada ao próximo artefato.
- A numeração `0005` pressupõe `adr-0004` reservado à decisão de traits
  (registrada no wiki, ainda sem ADR próprio) e `adr-0003` já existente
  apenas na branch do PR #4
  (`docs/adr-0003-gate-de-regra-voto-fases-predecessores-dependencia.md`),
  não mesclado em `main` no momento desta decisão. Se a decisão de traits
  for abandonada e o arquivo `0004` nunca
  nascer, a numeração fica com um gap cosmético — aceito, sem ação
  necessária.
