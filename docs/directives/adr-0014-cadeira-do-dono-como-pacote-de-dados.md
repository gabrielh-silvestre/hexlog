# ADR 0014: Cadeira do dono como pacote de dados no setup

**Status:** Proposto

**Data:** 2026-10-29

**Deciders:** a preencher com o aceite do dono antes do merge (só o cabeçalho muda: Status passa a Aceito e Deciders inclui quem aprovou)

---

## Context

A cadeira do dono do [ADR 0012](adr-0012-cadeira-do-dono.md) vale só para o fluxo deste repositório: depende do Herdr, do OMC, do júri e de um `critic` em Opus. O dono quer a cadeira como recurso opt-in do produto, para qualquer repositório de destino e sem amarra a provedor de modelo: um modelo (o ocupante) responde as lacunas do executor com base em critérios do projeto, grava a resposta no hexlog, e o humano audita depois. Sem ocupante, o humano responde, com os mesmos tipos e o mesmo relatório.

Restrições que moldam a decisão:

- O servidor e as 12 tools não mudam (`ferramentas-fixas`, `nucleo-sem-termo-de-fluxo`): a entrega só pode ser dado, skill, script de leitura e doc.
- O instalador copia só `skills/` para `~/.claude/skills/` (`installation.ts#writeSkillFolder`), então o pacote precisa viver ali para funcionar em repositório vazio, sem o checkout do hexlog.
- A definição é fixada por processo (`definicao-fixada-por-processo`): a unidade aberta antes do pacote não enxerga os campos novos.
- O log é append-only (`log-so-acrescenta`): contestar é `revokes`, nunca edição.
- O [ADR 0013](adr-0013-setup-em-repositorio-de-destino.md), item 7, diz que o setup "só escreve a skill do projeto e o modelo".

## Decision

1. **Pacote de definições como dado.** Sete definições (4 tipos, 2 relações, 1 gate) em `skills/hexlog-setup/references/owner-seat/{types,relations,gates}/<nome>.json`, um arquivo por definição, no layout de `.hexlog/`: os tipos `gap`, `premise`, `evidence` e `audit`, as relações nomeadas `fills-gap` (espécie `answers`) e `audits` (espécie `supports`) e o gate `gaps`. Os campos novos são opcionais; quem não liga a cadeira não os preenche.
2. **Instruções geradas pelo setup.** Um documento de critérios com regras de chave estável (do dev: o setup nunca o sobrescreve), um contrato neutro e receitas por ferramenta (Claude e `agy`, por CLI direto) vão para a pasta da skill do projeto, a partir de templates em `skills/hexlog-setup/references/`. A receita do Claude libera ao ocupante seis tools do hexlog, quatro delas só de leitura (`query`, `read_attachment`, `describe_type` e `list`).
3. **Resposta, ausência de critério e auditoria.** O ocupante fecha a lacuna com uma `premise` (`fills-gap`, `answeredBy: simulated`). A resposta sem base sai com `basis: judgment`, a marca "sem critério". O humano audita depois: `audit` com relação `audits` avaliza; uma `premise` humana nova com `revokes` da resposta e `fills-gap` contesta. Aval e contestação vão para o processo da resposta, nunca `supersedes`.
4. **Colisão de nomes.** O setup decide por regra mecânica: tipo igual ou compatível (superconjunto do que o contrato grava) vira versão minor com campos opcionais; tipo incompatível pede ao dev um nome mapeado. O resultado fica em `ownerSeat` no `hexlog-model.json`, com `names`, `applied` e `occupant`; relação e gate evoluem por nome novo.
5. **Relatório read-only.** `scripts/seat-report.ts` lê os papéis `gap`, `premise` e `audit` e separa as respostas pelo que já foi auditado. Fica fora de `src/`, lê só por `composeReader`, não lê anexo e identifica as arestas pela espécie, então sobrevive ao mapeamento de nomes. A skill do projeto chama o script por `$HEXLOG_CHECKOUT`, e nenhum caminho de máquina é versionado; é por isso que o template da skill do projeto cita o relatório e os quatro `owner-seat-*.template.md` não citam caminho do repositório do hexlog.
6. **"Skill do projeto" é a pasta.** A leitura que o ADR declara: "skill do projeto", no item 7 do ADR 0013, inclui a pasta inteira com os arquivos de apoio da cadeira. O dono avalizou emendar o item 7; a [emenda de 2026-10-29](adr-0013-setup-em-repositorio-de-destino.md) registra isso no ADR 0013.
7. **Leitura de `nucleo-sem-termo-de-fluxo`.** A premissa vale para o servidor (`src/`), que segue sem termo de fluxo, e o relatório em `scripts/` é ferramenta opcional fora do núcleo. O dono avalizou essa leitura, sem emenda de `estrategia.md` neste ponto. A trava mecânica continua sendo `test/no-flow-terms.spec.ts`, que varre `scripts/` fora de `flow/`.
8. **Auditoria humana posterior.** O produto não tem aval prévio nem classe crítica: o modo autônomo opera com cadeira simulada e auditoria humana posterior. A premissa `dois-modos-de-uso` de [estrategia.md](estrategia.md) é emendada pelo dono, que a muda de "aval humano no que é crítico" para "auditoria humana posterior"; o agente nunca edita esse arquivo.

## Drivers

Premissas de [estrategia.md](estrategia.md): `nucleo-sem-termo-de-fluxo`, `ferramentas-fixas`, `definicao-fixada-por-processo`, `log-so-acrescenta`, `audita-decisoes-de-agentes` e `dois-modos-de-uso` (emendada). Mais dois critérios desta decisão: funcionar em repositório vazio sem o checkout do hexlog e não acoplar o pacote ao fluxo do repositório.

## Alternatives considered

1. Embutir a cadeira no servidor ou criar tool nova: rejeitada, viola `ferramentas-fixas` e não há canal servidor para cliente para disparar o modelo.
2. Fonte única do pacote em `.hexlog/`: rejeitada, o instalador não a copia e o produto passaria a depender do fluxo deste repositório.
3. Aval como premissa derivada (o `simulated-approved` do ADR 0012): rejeitada, mistura resposta e veredito e faz duas premissas fecharem a mesma lacuna.
4. `audits` de espécie `derivesFrom`: rejeitada, o `needsReview` do hexlog só marca `supports`, e a gravação perderia a recusa de destino não vigente.
5. Júri e classe crítica no pacote: rejeitados, o júri exige OMC (fora do produto) e a classe crítica com aval prévio contraria "sem humano no meio".
6. Confiança no pacote: rejeitada, as instruções variam por projeto e cada um define as suas.
7. Arquivo único de pacote: rejeitado, sem molde de teste e confundiria a varredura dos `*.example.json` de `references/`.
8. Caminho do checkout no modelo: rejeitado, `HEXLOG_CHECKOUT` evita versionar caminho de máquina.
9. Emenda ao ADR 0012 em vez de ADR novo: rejeitada, o 0012 é a cadeira do fluxo deste repositório e segue válido; o trade-off aqui é outro (pacote de dados contra servidor) e [documentacao.md](documentacao.md) manda ADR aceito só receber emenda ou ADR seguinte.

## Why chosen

É a menor entrega que cumpre o objetivo sem tocar `src/`. O relatório responde as perguntas de auditoria com arestas que o servidor já guarda e marca, e o pacote em arquivos pequenos pode ser ensaiado em memória no mesmo molde que os testes de `.hexlog/` usam.

## Consequences

- "Agnóstico de provedor" vale para o ocupante: o executor segue sendo o Claude Code, como no ADR 0013.
- O relatório é a primeira capacidade instalada que depende do checkout do hexlog. Não há terceiro bundle, para não tocar `installation.ts#Bundles`.
- O ocupante e o rastro (`answeredBy`, `basis`, `rule`, `actionUsed`) são autodeclarados; a regra citada não é conferida contra o anexo.
- Unidades abertas antes do pacote não usam os campos novos, e o ocupante não senta nelas: a pergunta vai ao humano.
- O ocupante do `agy` não tem deny nem allowlist e pode ler o diretório de dados; risco aceito, com o dono como responsável ([dados.md](../dados.md)).
- O fluxo deste repositório (`cadeira-do-dono.md`, `fluxo-hexlog.md`, ADR 0012) mantém o aval prévio na classe crítica e fica em tensão com a premissa `dois-modos-de-uso` emendada até a migração do fluxo para o pacote. A tensão é conhecida e aceita pelo dono; a regra vigente do repositório continua sendo a dos docs vivos.
- "Cadeira" e "ocupante" existem em dois glossários, com a distinção explícita em `CONTEXT-MAP.md`.
- O `supports` cru dos dependentes tem semântica invertida em relação à intuição (aqui só serve para o hexlog marcar o dependente quando a resposta for revogada); o contrato gerado explica.

## Follow-ups

Migrar o fluxo do repositório para o pacote (`jury` no enum de `actionUsed`, classe crítica, alinhar `cadeira-do-dono.md` à premissa emendada); conferir a regra citada contra o anexo; relatório de dependentes por resposta; `--criteria <arquivo>` para marcar resposta de versão defasada do documento; relação nomeada de espécie `supports` para dependentes; receita Codex quando provada; sync das diretrizes depois do merge.
