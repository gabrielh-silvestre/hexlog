# Changelog

Mudanças visíveis a quem usa o hexlog, por versão. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/), com a regra de [documentacao.md](docs/directives/documentacao.md) para quebra de contrato do agente. O histórico 0.x ficou fora: a 1.0 o reescreveu.

## [Não lançado]

### Adicionado

- O `details[]` do `kind-mismatch` do `register` ganha o campo opcional `kind`, com o `kind` do nome de relação fixado, e a mensagem diz para enviar só `as` ou esse `kind` (#300).
- O `hexlog-setup` configura um repositório de destino: aprende o fluxo do projeto por descoberta no repositório ou por entrevista, registra tipos, relações e gate, e gera ali uma skill do projeto e um modelo declarativo (`hexlog-model.json`). A camada C do plug no Spec Kit é a única ativa (#321).
- A `hexlog-flow` traz o ciclo de vida da unidade de trabalho em `references/unit-lifecycle.md` (#321).

### Alterado

- O `register` devolve no `INVALID_RECORD` de dado todas as violações de schema de cada registro do lote até um limite de custo (schema grande contra dado grande), e uma por subschema acima dele, não só a primeira, com um `detail` `violations-capped` (`path` `/records/<i>/data`) que avisa que a lista está incompleta e manda ler o tipo com `describe_type`; no máximo 50 `details`, e a `message` de `max-length`, `min-length`, `maximum` e `minimum` termina com o valor medido, como `(got 312)`. O teto de 16.000 caracteres de `data` segue `INVALID_INPUT` e também traz o tamanho (#300).
- O `register` junta no mesmo `INVALID_RECORD` as recusas de relação que só dependem da entrada (`unknown-relation-name`, `kind-mismatch` e `cross-process-currency`, com `path` `/records/<i>/relations/<n>`), depois das violações de schema e sob o mesmo teto de 50 `details`: um `max-length` não esconde mais um `kind-mismatch` do mesmo registro (#300).
- A descrição do `register`, o `docs/tools.md` e a skill `hexlog-flow` passam a ensinar que `as` sozinho basta numa relação, e as mensagens de `kind` fora da lista e de relação sem `kind` nem `as` dizem como corrigir (#300).
- `engines.node` passa de `>=24.18.1` para `^24.18.1`: o Node 25 e o 26 deixam de ser suportados, porque o `randomUUIDv7` só é estável a partir do 26.1.0 e o `eslint-plugin-n` 18.5.0 passou a recusá-lo na faixa aberta (#311).
- A `hexlog-flow` recebe projeto, processo e gate da skill do projeto, e deixa de ler o `.hexlog/flow.md` (#321).

### Removido

- O mapa por repositório (`.hexlog/flow.md`), o campo `editedSkills` e a edição de skills globais pelo `hexlog-setup` (#321).

### Migração

- O `INVALID_RECORD` de dado lista as violações de cada registro (todas até o limite de custo), e a `message` de limite de tamanho ganha o sufixo `(got N)`: quem comparava a `message` por igualdade passa a comparar o `code` (`max-length`, `min-length`, `maximum`, `minimum`), e o laço de correção pode tratar todos os `details` de uma vez, inclusive os de relação estática, que antes vinham sozinhos numa segunda rodada. As mensagens do `custom` de `data` (teto de 16.000 caracteres), de `kind` fora da lista e de relação sem `kind` nem `as` também mudaram: confira pelo `code`, não pelo texto (#300).
- Um `.hexlog/flow.md` antigo é ignorado: rode o `hexlog-setup` no repositório para gerar a skill do projeto e o modelo (#321).

## [1.2.2] - 2026-10-24

Aviso de versão: esta versão muda o formato padrão da `query` em `counts` (`inCounts` e `outCounts` deixam de contar a aresta não vigente) e, pela regra de [documentacao.md](docs/directives/documentacao.md), sairia como minor. Por decisão do dono saiu como patch, sem emendar a regra; a Migração abaixo diz como recuperar a soma antiga.

### Alterado

- A `query` em `counts` (o padrão da tool) passa a contar em `inCounts` e `outCounts` só as arestas vigentes e traz as não vigentes em `nonCurrentInCounts` e `nonCurrentOutCounts`, no mesmo formato: o apoio de uma premissa revogada deixa de parecer apoio vivo (#261).
- A skill `hexlog-flow` ganha a seção "Leitura enxuta", que ensina `fields`, `relations`, `changesSince` com `limit: 0` e `targets` para ler o log gastando menos contexto (#172).

### Migração

- `inCounts` e `outCounts` deixam de contar a aresta não vigente: a soma antiga é `inCounts` mais `nonCurrentInCounts` (e `outCounts` mais `nonCurrentOutCounts`), por chave. Não há parâmetro para o formato antigo; para as arestas inteiras use `relations: "full"` (campo `current`).
- `inheritedInCounts` e `inheritedOutCounts` seguem contando toda aresta herdada, porque a aresta herdada não carrega `current`.

## [1.2.1] - 2026-10-21

Patch de correções. O hook de isolamento do Bash passa a conferir o que vem depois de um `#` no comando, o instalador passa a limpar resíduos de execução interrompida e recusa com mensagem clara o filesystem sem hard link, e o servidor registra no stderr a queda do transporte stdio. A seção Migração traz o que a 1.1.2 deixou de avisar.

### Alterado

- A descrição do `register`, o `docs/tools.md`, a mensagem de `target-mismatch` e a skill `hexlog-flow` passam a ensinar a troca de target com um registro só, com `revokes` e `derivesFrom` para o antigo (#241).
- A skill `hexlog-flow` e o `docs/tools.md` passam a orientar o `expectedHead` do `verify_chain`: passe o `head` da verificação mais recente e guarde-o fora do log do hexlog, porque um `head` gravado no próprio log some junto com a cauda apagada (#244).

### Corrigido

- O hook de isolamento do Bash passa a conferir o trecho que vem depois de um `#`: `echo hi # x` seguido de quebra de linha e `cat <glob>`, ou `echo a#b; cat <glob>`, passavam sem checagem. Só a linha que o `shell-quote` não parseia (`${}`) continua liberada, e um par de aspas que cruza a quebra de linha depois do `#` ainda escapa da conferência (lacuna aceita, listada em `docs/dados.md`) (#242).
- O hook de isolamento mede o token entre aspas depois de expandir o `~`, como a classificação: `cat '~/sub/<token acima do teto só depois de expandir>*'` deixa de ser negado por custo. Com glob já no 1º segmento depois do `~/`, o comando segue negado, agora por alcançar o diretório de dados (falso positivo aceito) (#242).
- A varredura dos temporários legados do instalador casa `<nome>.(tmp|old)-<dígitos>` por prefixo, sem regex com o nome: nome de skill com `+`, `(` ou `[` não quebra mais a instalação (#244).
- A limpeza dos temporários legados de skills roda depois da troca da skill e ignora erro de remoção (`EACCES`): um resíduo sem permissão não aborta mais a instalação (#244).
- O instalador remove, na instalação seguinte, os temporários `.hexlog-skill-<nome>.tmp-<pid>` e `.old-<pid>` que um `kill -9` deixava em `~/.claude/`, só quando o pid do sufixo está morto (#244).
- O instalador recusa com mensagem clara o filesystem de `~/.claude` sem hard link (`EPERM` ou `ENOTSUP` no backup `settings.json.bak-hexlog`), antes de gravar o `settings.json` (#244).
- O servidor registra `transport-error` no stderr quando o transporte stdio falha, como uma linha de entrada acima de 10 MiB, que antes encerrava o servidor sem deixar rastro (#244).

### Migração

- Desde a 1.1.2, `read_attachment` recusa com `INVALID_INPUT` (`mid-surrogate-pair`) o `offset` que cai no meio de um par surrogate: quem pagina por passo fixo deve seguir o `next` de cada página. O servidor também recusa com `too-deep` argumentos aninhados além de 64 níveis (`data` do `register` acima de 61), que antes só falhavam perto de 2.000 níveis. A 1.1.2 listou o primeiro item só em Corrigido e nenhum dos dois na Migração (#126, release da 1.1.2; a mudança veio no #107).

## [1.2.0] - 2026-10-16

Esta versão quebra o contrato em três pontos e sai como minor: o formato padrão da `query` e do `evaluate_gate` mudou (`relations: "full"` e `evidence: "full"` trazem o antigo de volta), `limit: 0` sem `changesSince` troca de código de erro, e o `register` recusa `supersedes` entre targets. A Migração abaixo diz o que fazer em cada caso.

### Adicionado

- A `query` aceita `limit: 0` com `changesSince` (sem `cursor`) e devolve só as mudanças, com `records` vazio (#159).
- A `query` devolve `hint` quando um `targetPrefix` não casa nada, mas algum target começa pela string sem a fronteira de `.` (#159).
- A `query` aceita `relations` (`counts`, `full` ou `none`) para escolher como cada registro traz as relações; `counts` devolve `inCounts` e `outCounts`, o número de arestas por nome de relação (#161).
- O `evaluate_gate` aceita `evidence` (`failing`, `counts` ou `full`) para escolher quanto da evidência cada pergunta traz (#161).
- O `evaluate_gate` aceita `targets` (de 1 a 50) para avaliar vários targets numa só chamada e devolve `results`, um por target, com um só `marker` (#161). O lote responde em `evidence: "counts"` por padrão; para os ids de um target reprovado, avalie-o sozinho com o `marker` do lote.
- Em processo criado depois desta versão, as relações gravadas para a versão antiga de uma unidade passam a valer para a versão atual, só na leitura: o `supports` recebido pela versão antiga sobe para a atual (se quem apoia é vigente) e as citações enviadas pela antiga (`answers`, `derivesFrom`, `complements`, `reopens`) passam a sair da atual, com o mesmo destino; a `query` devolve `inheritedIn` e `inheritedOut` (com `origin`) e, em `counts`, `inheritedInCounts` e `inheritedOutCounts` (#166).
- O `evaluate_gate` aceita `inherit: true` nas perguntas `approved` e `no_pending` para contar o que vale só por herança, e traz `evidence.inherited` (com `evidence: "full"`; nos outros modos, `counts.inherited`) (#166).
- O `create_process` e o `list` com `process` expõem `lineageInheritance`, que só aparece em processo criado com a herança (#166).
- `scripts/export.ts` e `scripts/timeline.ts` mostram as relações herdadas: `inheritedIn` e `inheritedOut` no export, linhas `inherited in` e `inherited out` no timeline (#166).

### Alterado

- A descrição da `query` explica que o `targetPrefix` casa por segmento e que o id de qualquer registro do processo vale como `changesSince` (#159).
- O erro de `since` na `query` cita `changesSince` na mensagem (#159).
- `limit: 0` sem `changesSince` na `query` passa a devolver `INVALID_FILTER` (`/limit`, `out-of-range`) em vez de `INVALID_INPUT` (#159).
- A `query` devolve por padrão `inCounts` e `outCounts` no lugar de `in` e `out`, e o `evaluate_gate` devolve por padrão só as contagens da evidência, com os ids apenas da pergunta que reprova (#161).
- O `register` passa a recusar `supersedes` cujo destino tem outro target (`INVALID_RECORD`, `target-mismatch`); `revokes` entre targets segue permitido (#164).
- Em processo com herança, o `needsReview` deixa de marcar o `supports` que o registro atual só tem por herança (#166).

### Corrigido

- O hook de isolamento passa a negar o caminho de `<D>` escrito com escape ANSI-C (`cat $'…/hex\x6cog/x'`), que passava como lacuna aceita: o `shell-quote` decodifica o escape a partir da 1.11.0 (o lock fixa a 1.12.0), e a atualização também zera o aviso crítico do `npm audit` na 1.10.0 (#173).
- O hook de isolamento aplica os tetos por token (chaves, colchetes e comprimento) só aos tokens que o shell expande: `node -e '...'` e `python -c "..."` legítimos, com muitas chaves ou colchetes entre aspas, deixam de ser negados por custo; o orçamento total de glob ainda soma os tokens entre aspas que passam pela checagem de caminho, e a negação por custo agora diz que o comando não cita o diretório de dados literalmente (#169).

### Migração

- A `query` não devolve mais `in` e `out` por padrão: cada registro traz `inCounts` e `outCounts`, mapas `{<nome da relação>: n}` em que o nome é o `as` da relação (ou o `kind`, sem `as`); mapa vazio é omitido. Para receber `in` e `out` como antes, passe `relations: "full"`; para nenhum dos dois, `relations: "none"`.
- O `evaluate_gate` não devolve mais todas as listas de ids em `evidence`: cada pergunta traz `counts` e, só quando reprova, `evidence` com os ids que explicam a reprovação. Para receber todas as listas de ids como antes, passe `evidence: "full"`.
- Com `targets`, a resposta do `evaluate_gate` troca `questions` por `results` (`{target, passed, questions}` por target); `evidence: "full"` não vale em lote. Com `target`, ou sem nenhum dos dois, o formato segue o mesmo.
- Quem trocava o target de um fato com `supersedes` agora recebe `INVALID_RECORD` com `target-mismatch`: grave `revokes` no registro antigo e um registro novo no target certo, com `derivesFrom` para o antigo. Registros já gravados não mudam.
- Sessões abertas só veem o formato novo depois de reinstalar com `node scripts/install.ts` e reiniciá-las.
- Processos existentes não mudam: a herança só nasce com o processo e não há como ligá-la depois; eles seguem com a cascata manual de regravar a relação na versão nova.
- Para cortar uma herança, grave um `contradicts` entre as duas linhagens. Só o `contradicts` vigente corta: superar ou revogar o registro que o grava religa a herança. Ele também conta como contradição para `approved` e `no_open_contradiction` sobre o registro que aponta.
- Servidor ou sessão antiga não lê o `process.json` com `lineageInheritance` (`PROCESS_CORRUPTED`, `unreadable-manifest`), e um só processo assim no projeto basta para a 1.1.x falhar também em `list`, em `query` e `evaluate_gate` de alcance projeto e no `create_process` de qualquer processo, inclusive sobre os antigos: reinstale com `node scripts/install.ts` e reinicie todas as sessões antes de criar processo novo. Um gate com `inherit: true` faz o `create_process` da 1.1.x dar `INTERNAL` (`unreadable-definition`). O sintoma não é corrupção: não aplique a quarentena de `docs/dados.md`, reinstale a 1.2.0 e reinicie as sessões. Não há rollback para a 1.1.x depois de criar processo ou gate com `inherit` na 1.2.0.
- `inCounts` e `outCounts` contam toda aresta, vigente ou não; para saber se a origem é vigente, use `relations: "full"` (campo `current`) ou o gate.
- Em processo com herança, continuam manuais o `supports` que a versão superada emitia (regrave na versão nova com a revisão), o `derivesFrom` e o `answers` que ela recebia, e `contradicts`, `supersedes` e `revokes`, que nunca herdam.
- Em processo novo, o `needsReview` deixa de marcar (`staleOut`) o apoio que a versão superada deu: a herança o conta como apoio da versão atual, e não há opt-out.
- `limit: 0` sem `changesSince` na `query` agora devolve `INVALID_FILTER` (`/limit`, `out-of-range`) em vez de `INVALID_INPUT`; quem ramifica pelo código deve tratar os dois.

## [1.1.2] - 2026-10-09

### Adicionado

- `verify_chain` aceita `expectedHead`, o `head` de uma verificação anterior, e acusa `head-not-found` em `breaks` quando o log perdeu a cauda ou foi reescrito (#109).

### Alterado

- `verify_chain` devolve em `head` a âncora do processo (hash de 64 caracteres) quando o log não tem elo, no lugar de `''`; `totalRecords: 0` indica o log vazio (#109).
- O servidor recusa com `INVALID_INPUT` (`too-deep`) argumentos aninhados além de 64 níveis, em vez de estourar a pilha, e registra o aviso `tool-over-cap` quando uma resposta passa do dobro do teto de página, sem cortá-la (#107).
- O instalador guarda o primeiro `settings.json.bak-hexlog` e não o sobrescreve mais; quando `settings.json` é um link simbólico, grava no destino e preserva o link e o modo; falha antes do backup se o diretório do destino não é gravável. Os temporários da troca das skills ficam ao lado de `skills/`, e os `.tmp-<pid>` e `.old-<pid>` de versões antigas são removidos de `~/.claude/skills` (#113, #122).
- A mensagem de `holder-unreadable` traz o comando de destravamento pronto para colar (#110, #123).

### Corrigido

- `read_attachment` recusa com `INVALID_INPUT` (`mid-surrogate-pair`) um `offset` que cai no meio de um par surrogate; use o `next` devolvido pela página anterior (#107).

### Migração

- `verify_chain` devolve em `head` a âncora do processo, não mais `''`, quando o log não tem elo. Quem comparava `head === ''` para detectar log vazio deve usar `totalRecords === 0`.
- Se `~/.claude/skills` é um link para outro filesystem, a troca das skills passa a funcionar (os temporários ficam no pai do alvo real, ou em `~/.claude/` se ele não for gravável). Se é ponto de montagem direto, a troca falha com `EXDEV`, mas antes de o instalador gravar o `settings.json`; mantenha-o no filesystem de `~/.claude/`.
- Quem atualiza da 1.1.1 ou anterior tem um `settings.json.bak-hexlog` anterior à última instalação antiga, que a 1.1.2 não renova. Apague `~/.claude/settings.json.bak-hexlog` antes de reinstalar para a 1.1.2 gravar um backup novo.
- Feche as sessões abertas antes de instalar com `node scripts/install.ts` e reinicie-as depois.

## [1.1.1] - 2026-10-08

### Alterado

- Versão de manutenção, sem mudança de comportamento: o servidor passa a reportar 1.1.1 e a instalar em `~/.local/lib/hexlog/1.1.1/` (#104).

## [1.1.0] - 2026-10-08

### Adicionado

- Tool `describe_type`, que lê o schema de um tipo do processo ou do projeto. O contrato passa a ter 12 tools (#88).
- `query` aceita `fields` e projeta `data` na saída (#88).
- Catálogo de formatos para validar campos de texto, com `git-sha` (#101).

### Alterado

- `register` junta a primeira violação de schema de cada registro do lote em um só `INVALID_RECORD` (#88).
- `define_type` recusa `pattern` e `patternProperties`, e o `register` passa a ignorá-los em tipo já fixado (#101).
- `bash-guard` nega token hostil, limita o custo de glob por comando e libera o comando que não consegue decidir (#99).

### Migração

- Schema legado com `pattern` livre, reenviado em `define_type`, vira `INVALID_SCHEMA` (`pattern-not-allowed`). O caminho é `define_type` com `breaking: true`.
- Não há rollback para a 1.0.0 depois de `define_type` com `git-sha`. Um servidor 1.0.0 de sessão aberta devolve `INTERNAL` no `register` de processo que fixe os tipos novos, então encerre as sessões abertas antes de instalar.

## [1.0.0] - 2026-10-05

### Alterado

- O hexlog 0.x foi reescrito como um núcleo agnóstico de registros tipados, relações e gates declarativos, sem termo de fluxo no código. O log segue append-only, com cadeia sha256 + JCS (#78).
- Marco e Veredito viram Registro de um tipo definido pelo projeto, com relações tipadas (#78).
- `register` grava um lote atômico de 1 a 50 registros, com retentativa segura pela `key` (#78).
- Gates são perguntas declarativas que o servidor calcula; `evaluate_gate` só lê (#78).
- O contrato passa a ter 11 tools (#78).

### Migração

- Tools, erros e formato em disco mudam, e não há migração do dado: o instalador arquiva o dado 0.x num `.tar` verificado (`node scripts/install.ts --archive-0x`). Até lá, as tools respondem `LEGACY_DATA`.
- Feche todas as sessões do Claude Code antes de instalar e reinicie depois.

[Não lançado]: https://github.com/gabrielh-silvestre/hexlog/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/gabrielh-silvestre/hexlog/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/gabrielh-silvestre/hexlog/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/gabrielh-silvestre/hexlog/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/gabrielh-silvestre/hexlog/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/gabrielh-silvestre/hexlog/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/gabrielh-silvestre/hexlog/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/gabrielh-silvestre/hexlog/releases/tag/v1.0.0
