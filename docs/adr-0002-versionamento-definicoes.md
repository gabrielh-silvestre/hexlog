# ADR 0002: Versionamento de definições

**Status:** Aceito

**Data:** 2026-09-17

**Deciders:** Gabriel Henrique Silvestre Baldino; planejamento RALPLAN "versionamento de definições"

---

## Context

Desde o MVP (ADR 0001), `register_type`, `register_vocabulary` e
`register_gate` gravam `schemas/<name>.json`, `vocabulary/<owner>.json` e
`gates/<name>.json` com `writeJsonAtomic`: cada chamada nova **sobrescreve**
o arquivo do mesmo nome. O lock por processo (`process.json`, criado com
`linkSync` exclusivo) já existia desde o MVP, mas resolve um problema
diferente — concorrência na criação do processo. O problema real aqui era
outro: registrar uma definição de novo destrói o histórico da anterior, sem
aviso algum, mesmo quando a mudança é incompatível com processos que já
fixaram (`create_process`) a versão antiga no snapshot.

Isso deixa dois riscos sem tratamento: (1) não há como saber quais eventos
de um processo antigo foram validados contra qual forma exata de um tipo,
vocabulário ou gate; (2) uma mudança de vocabulário que remove um termo
antes válido pode invalidar retroativamente a leitura de eventos já
gravados, sem que o registro deixe rastro de que isso aconteceu.

## Decision

`register_type`, `register_vocabulary` e `register_gate` passam a versionar
em semver `major.minor` em vez de sobrescrever. Layout:
`schemas/<name>/<versão>.json`, `vocabulary/<owner>/<versão>.json`,
`gates/<name>/<versão>.json`. O arquivo legado `<name>.json` (de antes desta
mudança) nunca é apagado, reescrito ou materializado por cópia: continua
sendo a fonte da versão `1.0` para sempre, e o diretório de versões, quando
existe, começa em `1.1`. Um nome novo (sem legado) grava `1.0` direto no
diretório.

Quebra é o que faria um evento antes válido ser rejeitado: para
vocabulário, remover um termo de `milestoneType` ou `action` (campos
fechados) — remover de `result` não é quebra, porque é campo aberto; para
`type`, qualquer mudança de schema; para `gate`, nada, porque `criteria` não
participa de nenhuma validação de evento. Quebra bloqueia com o erro novo
`BREAKING_CHANGE`, só passando com `breaking: true` no input; a flag numa
mudança compatível produz minor com o aviso `NO_BREAKING_CHANGE`, em vez de
forçar major. Reregistro de conteúdo idêntico ao vigente é no-op:
`unchanged: true` com a versão vigente, sem gravar nada. As três tools
trocam `replaced: boolean` na saída por `version`, `previousVersion` e
`unchanged`, mais `warnings`. `process.json` ganha o bloco opcional
`versions` ({types, vocabulary, gates}), fixado no `create_process` e fora
do cálculo de `hashes`/`verifyHashes`. Continuam sendo exatamente 10 tools.

## Drivers

- Sobrescrever silenciosamente destrói o único registro de "contra qual
  forma exata um evento antigo foi validado" — o problema central que esta
  mudança resolve.
- O spec exige explicitamente que nada seja migrado ou reescrito em disco:
  qualquer solução que tocasse o legado (mesmo de forma aditiva) contraria
  esse não-objetivo.
- `test/stdio.e2e.spec.ts` já sobe processos MCP concorrentes no mesmo
  `dataDir` — corrida entre `register_*` no mesmo nome não é hipotética.

## Alternatives Considered

- **Continuar sobrescrevendo e aceitar a perda de histórico** — rejeitada:
  contradiz a garantia central que esta mudança existe para dar.
- **Materializar `<name>/1.0.json` por cópia aditiva do legado no primeiro
  registro versionado** — rejeitada pelo usuário: estica "nada é migrado ou
  reescrito" além do combinado, mesmo sendo uma cópia aditiva.
- **Materializar o legado sob demanda, no primeiro `list`/leitura (lazy)**
  — mesma objeção: ainda escreve em disco um dado que ninguém pediu para
  versionar.
- **Um lock externo (arquivo `.lock`, mutex em memória) por definição** para
  a escrita de versão — rejeitada: mais um primitivo para manter, quando
  `linkSync` (exclusivo por semântica do syscall) já resolve com o padrão
  que o código já usa em `createProcess`.
- **Serializar todos os `register_*` num único processo/fila** — rejeitada:
  exige coordenação entre processos MCP separados (cada servidor stdio é um
  processo independente), fora do escopo "sem daemon" do MVP.
- **Validar `result` do vocabulário contra a mesma regra de quebra dos
  campos fechados** — rejeitada: `result` já é campo aberto por decisão do
  MVP (QN3, ADR 0001); tratá-lo como fechado aqui inverteria essa decisão
  sem necessidade.

## D1 — Escrita exclusiva por `linkSync` + retry

**Decision.** Cada `<name>/<versão>.json` é gravado com `linkSync` exclusivo
(arquivo temporário no mesmo diretório + `fs.linkSync`), nunca com
`writeJsonAtomic`. Em `EEXIST`, o retry refaz a decisão inteira — não só o
número da versão: relê o vigente do disco, checa `unchanged` contra ele,
roda a detecção de quebra contra ele, e só então bumpa. `unchanged` e
`BREAKING_CHANGE` terminam o laço na hora, sem retry. O primitivo de
escrita (`writeThenLinkExclusive`) é extraído do que já fazia
`createExclusiveFile`, reaproveitado para os três `register_*`.

**Drivers.** `writeJsonAtomic` termina em `fs.renameSync`, que sobrescreve o
destino em silêncio — correto sob o comportamento antigo (um `register_*`
sempre substitui o mesmo arquivo), mas catastrófico sob versionamento: duas
chamadas concorrentes no mesmo nome podem calcular o mesmo alvo
`<versão>.json`, e a segunda apagaria a primeira, ambas retornando sucesso.
O padrão exclusivo já existe no código (`createExclusiveFile`), então o
custo de adotá-lo nos três `register_*` é baixo — extração, não invenção.

**Alternatives considered.** Ver "Alternatives Considered" acima (lock
externo, fila serializada) — mesmas rejeições, aplicadas especificamente à
escrita de versão.

**Why chosen.** `linkSync` + retry é o primitivo mais barato que garante a
propriedade que faltava (nunca duas escritas concorrentes produzem sucesso
silencioso na mesma versão), reaproveita código já testado e não introduz
processo, lock file nem dependência nova.

**Consequences.** Um bug de contrato foi corrigido antes da implementação
final: recalcular só o número da versão fora do laço de retry (e não a
decisão inteira) permitia que duas gravações concorrentes do mesmo conteúdo
produzissem uma versão redundante em vez de `unchanged: true` na segunda, e
que um candidato sem quebra contra o vigente inicial escapasse do bloqueio
`BREAKING_CHANGE` se o vigente mudasse entre a leitura e a escrita. O
contrato final — decisão inteira recomputada a cada tentativa, inclusive a
primeira — fecha os dois casos.

## D2 — Legado não é materializado

**Decision.** O arquivo legado `<name>.json` permanece a fonte da versão
`1.0` para sempre; o diretório `<name>/`, quando existe, começa em `1.1`.
Nenhuma cópia de `1.0.json` é criada no diretório de versões.

**Drivers.** "Nada é migrado ou reescrito em disco" é não-objetivo
explícito do spec — materializar `1.0.json` por cópia, mesmo aditiva,
escreveria em disco um dado que ninguém pediu para versionar. O legado já é
lido de forma tolerante como `1.0` (leitura resolvida por
`resolveCurrentDefinition`); materializar seria resolver de novo um
problema já resolvido pela leitura tolerante.

**Alternatives considered.** Materializar por cópia aditiva no primeiro
registro versionado, ou materializar sob demanda no primeiro `list`/leitura
(lazy) — ambas rejeitadas pelo usuário, ver "Alternatives Considered" acima.

**Why chosen.** É a opção que não escreve nada em disco além do que o
próprio spec pede, e reaproveita a leitura tolerante já decidida no MVP.

**Consequences.** O legado vira dependência permanente de leitura: todo
código que resolve a versão vigente ou lista o histórico de uma definição
(`resolveCurrentDefinition`, `listVersions`, `buildSnapshot`) precisa
continuar checando o arquivo solto ao lado do diretório de versões, para
sempre — não há um ponto no futuro em que o legado deixa de precisar ser
considerado.

## Consequences

- As três tools de registro ganham um parâmetro `breaking?: boolean` no
  input e trocam a saída (`replaced` sai; `version`/`previousVersion`/
  `unchanged`/`warnings` entram).
- `list` nível-projeto passa a trazer `version` (vigente, mutável a cada
  novo registro) e `versions[]` por definição; nível-processo traz o bloco
  `versions` fixado na criação, ausente em processo legado.
- Comparação de versão é sempre numérica por `(major, minor)`
  (`compareVersions`), nunca ordenação de string — evita `"1.10" < "1.9"`
  lexicográfico.
- `versions` em `process.json` fica fora de `verifyHashes`: é informativo,
  não faz parte da garantia de integridade da cadeia, e pode divergir do
  disco sem que `PROCESS_CORRUPTED` detecte.
- Nenhum `process.json` gravado antes desta mudança precisa de migração: o
  campo é opcional e sua ausência é tratada como processo legado.

## Follow-ups

Nenhum registrado nesta iteração.
