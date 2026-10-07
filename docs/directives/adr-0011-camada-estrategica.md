# ADR 0011: Camada estratégica no fluxo do hexlog

**Status:** Aceito

**Data:** 2026-10-07

**Deciders:** Gabriel Baldino (desenho da camada e aprovação no PR #90), com o plano de consenso entre planner, architect e critic

---

## Context

O fluxo guiado por diretrizes ([ADR 0010](adr-0010-camada-sobre-omc.md), [fluxo-hexlog.md](fluxo-hexlog.md)) ancora cada `decision` numa `directive` técnica ou numa `gap`. Falta o porquê em linguagem de produto: a diretriz diz como o código é, não o que o produto não pode deixar de ser. Sem isso, toda lacuna técnica sobe ao dono, mesmo quando uma premissa do trabalho a resolveria.

A camada nova acrescenta **premissas** sem tocar `src/`. Três restrições a moldam:

- Nenhum campo novo em tipo existente: `decision`, `gap` e `opening` ficam como estão.
- Só entra o que o servidor já oferece (`kind` nativo, `from` em lista no gate e na relação). O gate só lê relação de entrada, então parte da regra não é imponível por ele.
- Definição é imutável e fixada por processo: acertar os arquivos de `.hexlog/` antes do `define_*`, e nunca quebrar um processo em andamento.

As premissas atemporais ficam em [estrategia.md](estrategia.md), validadas pelo dono; o agente nunca as edita sozinho.

## Decision

1. **Camada de premissas.** Existe o tipo `premise` (`statement` até 255 caracteres), acima das diretrizes técnicas. As atemporais moram em `directives-2` (de [estrategia.md](estrategia.md)) e as da entrega no processo do trabalho; só o lugar as distingue. Recusado: reusar `directive` (`source` obrigatório, `rule` até 400 e `closes-gap` abriria o caminho que a auditoria trata como suspeito).
2. **Citação.** Toda `decision` liga a pelo menos uma premissa por `rests-on` (`derivesFrom`, de `decision` para `premise`), ou à sentinela `directives.estrategia.none` quando nenhuma se aplica. Recusado: relação de `premise` para `decision`, que o gate cobraria, mas a escrita exigiria uma premissa nova por decisão ou um tipo-ligação.
3. **Premissa que fecha lacuna.** A premissa da entrega fecha uma `gap` por `fills-gap` (`answers`, de `premise` para `gap`) se não contradiz premissa atemporal nem diretriz técnica. É sempre registro novo, nunca `supersedes`, porque a relação só vale gravada na criação. Premissa errada: outra nova, com `revokes` da errada.
4. **Gate `gaps`.** Aceita `directive` ou `premise` como fechador numa só pergunta (`resolvedBy.from` em lista); `closes-gap` continua só de `directive`. Recusado: duas perguntas `no_pending` (o gate faz AND e exigiria os dois fechadores) e alargar `closes-gap` (mistura os dois conceitos).
5. **Teto técnico e contradição.** Diretriz técnica é teto fixo: se a premissa esbarra nela, o agente escolhe outro caminho, sem perguntar. Contradição com premissa atemporal deixa a lacuna aberta e o PR em rascunho até o dono escolher: mudar o rumo, ou emendar a premissa com validação dele.
6. **Evidência.** O tipo `evidence` (`summary` de 1 a 300 caracteres e `source` como anexo) é opcional e se liga à `decision` vigente por `supports` cru. Quando o humano pede justificativa, o agente pesquisa e registra a evidência tardia. Recusado: `source` como string (o anexo é imutável e conferido por `verify_chain`).
7. **Objetivo da entrega.** É a primeira premissa do trabalho, `<slug>.premise.objective`. Recusado: campo `objective` em `opening` (cria campo em tipo existente) e tipo próprio (tipo a mais).
8. **Conferência pela auditoria.** A citação de premissa e a honestidade da premissa que fecha lacuna são conferidas pela `flow-audit`, com 3 indicadores sobre a população inteira, e não pelo gate, que só lê relação de entrada. O caminho mecânico é a pergunta `anchored` da issue #86.
9. **Limite aceito do gate `gaps`.** Como o agente escreve a premissa que fecha a própria lacuna, o gate perde peso mecânico. Não é violação: o freio é o indicador 1 da auditoria (premissa com `fills-gap` contra todo o [estrategia.md](estrategia.md)), e só a #86 dá imposição mecânica.
10. **Vale nos dois modos.** Em `autonomous` e em `ask` muda só quem decide a lacuna; o log e a auditoria são os mesmos. Lacuna que compromete o trabalho inteiro para e pergunta em qualquer modo.
11. **Processo `directives-2`.** A geração de diretrizes passa a `directives-2`, com os tipos e relações novos e o gate `gaps` em 1.1. Processo criado antes do `define_*` mantém as versões fixadas e segue sem premissas; não há mudança em `src/`, bump nem reinstalação.

## Consequences

- A lacuna técnica deixa de ir ao dono: o agente a fecha com premissa da entrega, dentro do teto das diretrizes. A decisão ganha o porquê em linguagem de produto e a auditoria ganha indicadores sobre ele. O servidor não muda.
- **Tensão do gate `gaps` (limite aceito, não violação):** o agente escreve a premissa que fecha a própria lacuna, então o gate verde não prova que ela é honesta. Sem a auditoria, uma premissa que contradiz [estrategia.md](estrategia.md) passa.
- A citação não é imposta: decisão sem `rests-on` passa pelo gate. O indicador 3 lista as sem citação, as só com sentinela ou objetivo e as com `rests-on` de premissa não vigente (`derivesFrom` não passa pela checagem de vigência, e a decisão fica "muda" sem aviso do servidor).
- `directives-2` pede recarga: o primeiro `flow-run` depois do merge reemite as regras, e o dono vê só o diff de regras, com [estrategia.md](estrategia.md) como bloco único já validado no PR. A `directive` da geração 1 que fechou lacuna segue valendo, porque o gate `gaps` lê o projeto inteiro.
- Premissa da entrega é texto do agente. Dois tipos e duas relações novos a manter em `.hexlog/` e no spec.
- Follow-ups:
  - Implementar a pergunta `anchored` (issue #86) quando a primeira auditoria achar decisão sem `rests-on`.
  - Validador do JSON de entrada do `sync-plan` e guarda `doc-path-mismatch` (hoje um `docSlug` errado mandaria `estrategia` ao ramo de `directive` sem erro; a skill deriva o slug do nome do arquivo e a auditoria detecta o caso).
  - Revisar a rota `direct` (ajuste pontual, só a premissa-objetivo derivada do pedido, sem validação).
  - Relação nomeada para `evidence`, se o `supports` solto ligar tipo errado.
