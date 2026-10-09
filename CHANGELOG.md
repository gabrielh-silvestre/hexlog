# Changelog

Mudanças visíveis a quem usa o hexlog, por versão. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/). O histórico 0.x ficou fora: a 1.0 o reescreveu.

## [Não lançado]

## [1.1.2] - 2026-10-09

### Adicionado

- `verify_chain` aceita `expectedHead`, o `head` de uma verificação anterior, e acusa `head-not-found` em `breaks` quando o log perdeu a cauda ou foi reescrito (#109).

### Alterado

- `verify_chain` devolve em `head` a âncora do processo (hash de 64 caracteres) quando o log não tem elo, no lugar de `''`; `totalRecords: 0` indica o log vazio (#109).
- O servidor recusa com `INVALID_INPUT` (`too-deep`) argumentos aninhados além de 64 níveis, em vez de estourar a pilha, e registra o aviso `tool-over-cap` quando uma resposta passa do dobro do teto de página, sem cortá-la (#107).
- O instalador guarda o primeiro `settings.json.bak-hexlog` e não o sobrescreve mais; quando `settings.json` é um link simbólico, grava no destino e preserva o link e o modo; falha antes do backup se o diretório do destino não é gravável. Os temporários da troca das skills ficam em `~/.claude/`, e os `.tmp-<pid>` e `.old-<pid>` de versões antigas são removidos de `~/.claude/skills` (#113, #122).
- A mensagem de `holder-unreadable` traz o comando de destravamento pronto para colar (#110, #123).

### Corrigido

- `read_attachment` recusa com `INVALID_INPUT` (`mid-surrogate-pair`) um `offset` que cai no meio de um par surrogate; use o `next` devolvido pela página anterior (#107).

### Migração

- `verify_chain` devolve em `head` a âncora do processo, não mais `''`, quando o log não tem elo. Quem comparava `head === ''` para detectar log vazio deve usar `totalRecords === 0`.
- Se `~/.claude/skills` é link ou mount em outro filesystem, mantenha-o no mesmo filesystem de `~/.claude/`, senão a troca das skills falha com `EXDEV`.
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
