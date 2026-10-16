# Changelog

Mudanças visíveis a quem usa o hexlog, por versão. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/). O histórico 0.x ficou fora: a 1.0 o reescreveu.

## [Não lançado]

### Adicionado

- A `query` aceita `limit: 0` com `changesSince` (sem `cursor`) e devolve só as mudanças, com `records` vazio (#159).
- A `query` devolve `hint` quando um `targetPrefix` não casa nada, mas algum target começa pela string sem a fronteira de `.` (#159).
- A `query` aceita `relations` (`counts`, `full` ou `none`) para escolher como cada registro traz as relações; `counts` devolve `inCounts` e `outCounts`, o número de arestas por nome de relação (#161).
- O `evaluate_gate` aceita `evidence` (`failing`, `counts` ou `full`) para escolher quanto da evidência cada pergunta traz (#161).
- O `evaluate_gate` aceita `targets` (de 1 a 50) para avaliar vários targets numa só chamada e devolve `results`, um por target, com um só `marker` (#161).
- Em processo criado depois desta versão, as relações gravadas para a versão antiga de uma unidade passam a valer para a versão atual, só na leitura: a `query` devolve `inheritedIn` e `inheritedOut` (com `origin`) e, em `counts`, `inheritedInCounts` e `inheritedOutCounts` (#165).
- O `evaluate_gate` aceita `inherit: true` nas perguntas `approved` e `no_pending` para contar o que vale só por herança, e traz `evidence.inherited` (#165).
- O `create_process` e o `list` expõem `lineageInheritance`, que só aparece em processo criado com a herança (#165).

### Alterado

- A descrição da `query` explica que o `targetPrefix` casa por segmento e que o id de qualquer registro do processo vale como `changesSince` (#159).
- O erro de `since` na `query` cita `changesSince` na mensagem (#159).
- `limit: 0` sem `changesSince` na `query` passa a devolver `INVALID_FILTER` (`/limit`, `out-of-range`) em vez de `INVALID_INPUT` (#159).
- A `query` devolve por padrão `inCounts` e `outCounts` no lugar de `in` e `out`, e o `evaluate_gate` devolve por padrão só as contagens da evidência, com os ids apenas da pergunta que reprova (#161).
- O `register` passa a recusar `supersedes` cujo destino tem outro target (`INVALID_RECORD`, `target-mismatch`); `revokes` entre targets segue permitido (#164).
- Em processo com herança, o `needsReview` deixa de marcar o `supports` que o registro atual só tem por herança (#165).

### Migração

- A `query` não devolve mais `in` e `out` por padrão: cada registro traz `inCounts` e `outCounts`, mapas `{<nome da relação>: n}` em que o nome é o `as` da relação (ou o `kind`, sem `as`); mapa vazio é omitido. Para receber `in` e `out` como antes, passe `relations: "full"`; para nenhum dos dois, `relations: "none"`.
- O `evaluate_gate` não devolve mais todas as listas de ids em `evidence`: cada pergunta traz `counts` e, só quando reprova, `evidence` com os ids que explicam a reprovação. Para receber todas as listas de ids como antes, passe `evidence: "full"`.
- Com `targets`, a resposta do `evaluate_gate` troca `questions` por `results` (`{target, passed, questions}` por target); `evidence: "full"` não vale em lote. Com `target`, ou sem nenhum dos dois, o formato segue o mesmo.
- Quem trocava o target de um fato com `supersedes` agora recebe `INVALID_RECORD` com `target-mismatch`: grave `revokes` no registro antigo e um registro novo no target certo, com `derivesFrom` para o antigo. Registros já gravados não mudam.
- Sessões abertas só veem o formato novo depois de reinstalar com `node scripts/install.ts` e reiniciá-las.
- Processos existentes não mudam: a herança só nasce com o processo e não há como ligá-la depois; eles seguem com a cascata manual de regravar a relação na versão nova.
- Para cortar uma herança, grave um `contradicts` entre as duas linhagens. Só o `contradicts` vigente corta: superar ou revogar o registro que o grava religa a herança. Ele também conta como contradição para `approved` e `no_open_contradiction` sobre o registro que aponta.
- Servidor ou sessão antiga não lê o `process.json` com `lineageInheritance` (`PROCESS_CORRUPTED`, `unreadable-manifest`): reinstale com `node scripts/install.ts` e reinicie todas as sessões antes de criar processo novo.

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

[Não lançado]: https://github.com/gabrielh-silvestre/hexlog/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/gabrielh-silvestre/hexlog/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/gabrielh-silvestre/hexlog/releases/tag/v1.0.0
