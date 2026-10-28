# hexlog

Servidor MCP para agentes registrarem o próprio histórico de trabalho.

É um servidor MCP _(Model Context Protocol)_ stdio que permite ao agente gravar registros tipados, ligar um registro a outro e checar gates declarativos, tudo num log append-only por processo. Cada registro referencia o hash do anterior, dessa forma qualquer linha alterada ou removida do meio quebra a cadeia e a tool `verify_chain` detecta; apagar a cauda só é detectado contra um head guardado antes (`expectedHead`). Não tem CLI nem daemon, apenas o servidor e um hook de isolamento instalados no Claude Code.

## Instalação

Precisamos de:

- Linux (o lock por pid e o arquivador dependem de `/proc`, de hard link e de `fsync` de diretório);
- Node `^24.18.1`;
- Claude Code, com `~/.claude/settings.json` já existente.

```sh
npm ci
npm test
node scripts/install.ts
```

O instalador constrói o servidor e o hook, copia os bundles para `~/.local/lib/hexlog/<versão>/`, registra o hook e o servidor MCP no Claude Code e instala as skills em `~/.claude/skills/`. Depois de instalar, reiniciamos o Claude Code, porque a lista de tools é cache da sessão. Para atualizar, repetimos os mesmos comandos, e `node scripts/install.ts --check` apenas verifica, sem escrever nada.

Obs: _com dado 0.x em `<D>` o instalador só lista o que arquivaria e sai com código 2, o passo a passo está em [docs/migracao.md](docs/migracao.md)._

## Início rápido

Com o hexlog instalado e o Claude Code reiniciado:

1. `node scripts/install.ts --check` confirma que o servidor, o hook e as skills estão no lugar, sem escrever nada;
2. perguntamos ao agente "o hexlog está funcionando?", e a skill `hexlog` diagnostica o servidor instalado;
3. num projeto novo, o agente define um tipo, cria um processo, registra e consulta.

O passo a passo com as chamadas de cada tool, incluindo `define_gate` e `evaluate_gate`, está em [docs/uso.md](docs/uso.md).

Próximo passo depois de instalar: para configurar um repositório seu, pedimos ao agente "configura o hexlog nesse repositório" e a skill `hexlog-setup` conduz o resto ([Configurar um repositório novo](docs/uso.md#configurar-um-repositório-novo)).

## Tools MCP

O servidor expõe exatamente 12 tools. A entrada, a saída e os erros de cada uma estão em [docs/tools.md](docs/tools.md).

| Tool | O que faz | Escreve |
|---|---|---|
| `list` | Descobre projetos, ou um projeto com processos e definições, ou o que um processo fixou | nada |
| `describe_type` | Lê o schema de um tipo: o fixado no processo ou a versão vigente do projeto | nada |
| `define_type` | Define um tipo de registro (JSON Schema) como versão imutável | definição do projeto |
| `define_relation` | Define um nome de relação, com os tipos permitidos nas pontas | definição do projeto |
| `define_gate` | Define um gate: uma lista de perguntas sobre os registros | definição do projeto |
| `create_process` | Cria um processo e fixa a versão vigente de cada definição | `process.json` |
| `register` | Grava um lote atômico de registros, com relações e `key` de idempotência | `records.jsonl` |
| `query` | Lê registros vigentes, com filtros, relações, projeção de `data` e mudanças desde um marcador | nada |
| `evaluate_gate` | Calcula um gate fixado no processo e devolve a evidência | nada |
| `verify_chain` | Verifica a cadeia de hash do log e os anexos citados | nada |
| `attach` | Guarda um texto como anexo imutável | anexo do projeto |
| `read_attachment` | Lê uma página de um anexo por hash | nada |

## Skills

O instalador copia as skills de `skills/` para `~/.claude/skills/`. Elas guiam o uso das tools:

| Skill | Quando usar |
|---|---|
| `hexlog` | Subir um projeto novo (tipos, relações, gates e processo) ou diagnosticar se o servidor instalado está saudável |
| `hexlog-setup` | Configurar um repositório de destino: aprende o fluxo do projeto (descoberta ou entrevista), registra tipos, relações e gate e gera a skill do projeto com o modelo declarativo. Pode rodar de novo |
| `hexlog-flow` | Dia a dia: registra, consulta, avalia gates, anexa texto, audita um target e conduz o ciclo de vida da unidade de trabalho, com projeto, processo e gate vindos da skill do projeto |

## Como funciona

Os dados ficam em `$XDG_DATA_HOME/hexlog/` (ou `~/.local/share/hexlog`), com um diretório por projeto e um log JSONL por processo. O log é append-only e cada linha carrega o hash da anterior, ou seja, nenhuma alteração passa despercebida pela `verify_chain`, exceto apagar as últimas linhas, que só aparece contra um head guardado antes (`expectedHead`). Só o servidor escreve nesse diretório, pois o hook PreToolUse bloqueia o acesso do agente via Bash, e o isolamento tem lacunas conhecidas, descritas em [docs/dados.md](docs/dados.md). As sessões executam sempre a cópia instalada em `~/.local/lib/hexlog/<versão>/`, nunca a working tree, logo mudar o código só tem efeito depois de rodar o instalador de novo.

## Fluxo guiado por diretrizes

O servidor não conhece nenhum fluxo de trabalho: o fluxo mora em definições (`.hexlog/`) e em docs. Neste repositório usamos o próprio hexlog para desenvolver o hexlog, e as regras estão em [docs/directives/fluxo-hexlog.md](docs/directives/fluxo-hexlog.md):

- cada trabalho é um processo, nomeado pelo slug da branch, com premissas, decisões, lacunas, evidências e achados como registros tipados;
- os gates `pre-pr` e `gaps` precisam estar verdes antes de o PR sair de rascunho; lacuna aberta mantém o PR em rascunho;
- no modo `ask` o humano decide e o agente explora; no `autonomous` (padrão) o agente decide dentro das diretrizes e das premissas de [docs/directives/estrategia.md](docs/directives/estrategia.md);
- no `autonomous`, a lacuna vai à cadeira do dono, um `critic` durável que responde no lugar do humano, e o humano avaliza as respostas críticas no pré-PR ([docs/directives/cadeira-do-dono.md](docs/directives/cadeira-do-dono.md)).

As skills do fluxo ficam em `.claude/skills/` e valem só neste repositório, o instalador não as copia: `flow-run` (abre o trabalho e conduz até o pré-PR), `flow-gaps` (fecha as lacunas de um PR em rascunho), `flow-audit` (audita por amostragem as decisões registradas) e `flow-owner-seat` (papel de quem ocupa a cadeira do dono).

## Documentação

- [docs/uso.md](docs/uso.md): 5 passos, exemplo completo e tabela das tools;
- [docs/tools.md](docs/tools.md): entrada, saída e erros de cada tool;
- [docs/instalacao.md](docs/instalacao.md): instalação concorrente, `--check` e como reverter;
- [docs/setup-aceitacao.md](docs/setup-aceitacao.md): roteiro manual de aceite do `hexlog-setup` num repositório de destino;
- [docs/migracao.md](docs/migracao.md): arquivamento do dado 0.x e migração para a 1.0;
- [docs/dados.md](docs/dados.md): layout em disco, erros, lock e lacunas de isolamento;
- [docs/desenvolvimento.md](docs/desenvolvimento.md): scripts de leitura e testes;
- [docs/feedback-loops.md](docs/feedback-loops.md): o que o commit e o pré-PR conferem;
- [docs/directives/](docs/directives/AGENTS.md): regras vivas do repositório, do fluxo às convenções;
- ADRs: [0007 domínio](docs/directives/adr-0007-dominio.md), [0008 serviços](docs/directives/adr-0008-servicos.md), [0009 ferramental](docs/directives/adr-0009-ferramental.md), [0010 camada sobre o OMC](docs/directives/adr-0010-camada-sobre-omc.md), [0011 camada estratégica](docs/directives/adr-0011-camada-estrategica.md) e [0012 cadeira do dono](docs/directives/adr-0012-cadeira-do-dono.md), [0013 setup em repositório de destino](docs/directives/adr-0013-setup-em-repositorio-de-destino.md).

## Desenvolvimento

```sh
npm test            # jest, direto no código-fonte .ts
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # esbuild, gera os bundles .mjs
```

## Licença

[MIT](LICENSE)
