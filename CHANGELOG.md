# Changelog

Mudanças visíveis a quem usa o hexlog, por versão. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/). O histórico 0.x ficou fora: a 1.0 o reescreveu.

## [Não lançado]

### Adicionado

- `verify_chain` aceita `expectedHead`, o `head` de uma verificação anterior, e acusa `head-not-found` em `breaks` quando o log perdeu a cauda ou foi reescrito (#109).

### Alterado

- `verify_chain` devolve em `head` a âncora do processo (hash de 64 caracteres) quando o log não tem elo, no lugar de `''`; `totalRecords: 0` indica o log vazio (#109).

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
