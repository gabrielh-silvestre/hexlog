# hexlog

Servidor MCP para agentes registrarem o próprio histórico de trabalho.

É um servidor MCP _(Model Context Protocol)_ stdio que permite ao agente gravar registros tipados, ligar um registro a outro e checar gates declarativos, tudo num log append-only por processo. Cada registro referencia o hash do anterior, dessa forma qualquer linha alterada ou removida quebra a cadeia e a tool `verify_chain` detecta. Não tem CLI nem daemon, apenas o servidor e um hook de isolamento instalados no Claude Code.

## Instalação

Precisamos de:

- Linux (o lock por pid e o arquivador dependem de `/proc`, de hard link e de `fsync` de diretório);
- Node `>= 24.18.1`;
- Claude Code, com `~/.claude/settings.json` já existente.

```sh
npm ci
npm test
node scripts/install.ts
```

O instalador constrói o servidor e o hook, copia os bundles para `~/.local/lib/hexlog/<versão>/`, registra o hook e o servidor MCP no Claude Code e instala as skills em `~/.claude/skills/`. Depois de instalar, reiniciamos o Claude Code, porque a lista de tools é cache da sessão. Para atualizar, repetimos os mesmos comandos, e `node scripts/install.ts --check` apenas verifica, sem escrever nada.

Obs: _com dado 0.x em `<D>` o instalador só lista o que arquivaria e sai com código 2, o passo a passo está em [docs/migracao.md](docs/migracao.md)._

## Uso

O agente chama as 11 tools. Num projeto novo, o caminho mínimo é definir um tipo, criar um processo, registrar e consultar:

```json
// define_type
{ "project": "alpha", "name": "note",
  "schema": { "type": "object", "properties": { "text": { "type": "string" } },
              "required": ["text"], "additionalProperties": false } }

// create_process
{ "project": "alpha", "process": "run-1" }

// register
{ "project": "alpha", "process": "run-1", "agent": "executor",
  "records": [{ "type": "note", "target": "run.step", "data": { "text": "primeira nota" } }] }

// query
{ "project": "alpha", "process": "run-1" }
```

As skills instaladas guiam o resto: `hexlog` (instalação e diagnóstico), `hexlog-setup` (mapeia o fluxo de um repositório em `.hexlog/flow.md`, roda uma vez) e `hexlog-flow` (registra marcos e vereditos contra esse mapa). O exemplo completo e a tabela das tools estão em [docs/uso.md](docs/uso.md).

## Como funciona

Os dados ficam em `$XDG_DATA_HOME/hexlog/` (ou `~/.local/share/hexlog`), com um diretório por projeto e um log JSONL por processo. O log é append-only e cada linha carrega o hash da anterior, ou seja, nenhuma alteração passa despercebida pela `verify_chain`. Só o servidor escreve nesse diretório, pois o hook PreToolUse bloqueia o acesso do agente via Bash, e o isolamento tem lacunas conhecidas, descritas em [docs/dados.md](docs/dados.md). As sessões executam sempre a cópia instalada em `~/.local/lib/hexlog/<versão>/`, nunca a working tree, logo mudar o código só tem efeito depois de rodar o instalador de novo.

## Documentação

- [docs/uso.md](docs/uso.md): 5 passos, exemplo completo e tabela das tools;
- [docs/tools.md](docs/tools.md): entrada, saída e erros de cada tool;
- [docs/instalacao.md](docs/instalacao.md): instalação concorrente, `--check` e como reverter;
- [docs/migracao.md](docs/migracao.md): arquivamento do dado 0.x e migração para a 1.0;
- [docs/dados.md](docs/dados.md): layout em disco, erros, lock e lacunas de isolamento;
- [docs/desenvolvimento.md](docs/desenvolvimento.md): scripts de leitura e testes;
- ADRs: [0007 domínio](docs/directives/adr-0007-dominio.md), [0008 serviços](docs/directives/adr-0008-servicos.md) e [0009 ferramental](docs/directives/adr-0009-ferramental.md).

## Desenvolvimento

```sh
npm test            # jest, direto no código-fonte .ts
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # esbuild, gera os bundles .mjs
```

## Licença

[MIT](LICENSE)
