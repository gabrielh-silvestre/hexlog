# Fronteiras

Mapa de camadas (`src/`): `domain/` (puro) e `shared/` (carregador do log) na base; `ports.ts` declara as portas; `commands/` (escrita) e `queries/` (leitura) são serviços sobre as portas; `adapters/` implementa as portas (disco, validador, busca); `mcp/` expõe os serviços como tools; `compose.ts` é a única raiz de composição. Ficam fora do mapa os arquivos de raiz: `errors.ts` (importado por todas as camadas), `directory.ts`, `version.ts`, `server.ts` e `installation.ts`, `archive.ts` e `guard.ts`, que só o instalador usa. O porquê das decisões da frente de serviços está em [ADR 0008](adr-0008-servicos.md).

## Direção permitida de dependência

- `domain/` não importa `shared/`, `commands/`, `queries/`, `mcp/` nem `adapters/`, nem builtin do Node (salvo `crypto`) nem lib de infraestrutura. Exceção: importa `src/errors.ts` (`HexlogError` em `domain/definitions.ts` e `domain/chain.ts`), e `errors.ts` importa de volta só os tipos `Name` e `RecordId` (ciclo só de tipo). `eslint.boundaries.js` não proíbe `errors.ts` nem `ports.ts` dentro de `domain/`, então essa parte é convenção.
- Quem importa `shared/`: `commands/` e `queries/` (`latest.ts`, `loader.ts`, `pages.ts`, `logger.ts`), `compose.ts` (`loader.ts`, `logger.ts`) e `server.ts` (`logger.ts`); `mcp/` e `adapters/` só importam `shared/logger.ts`.
- `shared/`, `commands/` e `queries/` dependem de `domain/` e das portas, nunca de `adapters/`; `commands/` e `queries/` não se importam.
- `adapters/` só implementa portas: não importa `commands/`, `queries/` nem `mcp/` (`eslint.boundaries.js#adaptersBlock`); builtins do Node e libs de infraestrutura são o que ele existe para usar.
- `mcp/` chama só serviços: não importa `adapters/`, builtin do Node nem `compose.ts`; `mcp/kernel.ts` também não importa `mcp/tools/`.
- Só `server.ts`, os scripts e os testes importam `compose.ts`. Scripts de leitura passam por `compose.ts#composeReader` (só o lado de leitura, sem serviço de escrita: "script de leitura não grava" é garantia de tipo) e não importam `adapters/` nem `mcp/` (`scripts/install.ts` e `scripts/build.ts` ficam de fora).
- `guard.ts` e `installation.ts` não são importados por `server.ts` nem pelo hook; só por `scripts/install.ts`. Toda execução externa (spawn do hook, subida do servidor, relógio, `claude mcp`) entra por parâmetro injetado, nunca por chamada direta a `child_process` ou `Date.now` dentro da lógica testável; é isso que torna `installArtifact` e `verifyInstallation` testáveis sem processo real.

## Travas mecânicas

- `eslint.boundaries.js#scriptsBlock` e os demais blocos de `boundaryBlocks`, `NO_DYNAMIC_IMPORT` (import dinâmico barrado nas camadas com bloco: `domain/`, `shared/`, `ports.ts`, `commands/`, `queries/`, `mcp/` e `scripts/**` menos `install.ts` e `build.ts`, porque contornaria as travas de import) e `test/boundaries.spec.ts`.
- Fora dos blocos (`adapters/`, `hook/` e os arquivos de raiz de `src/`, exceto `ports.ts`) o lint não barra `import()`; a regra de não usá-lo é convenção, em [convencoes.md](convencoes.md).

## Checklist de review

- Serviço recebendo caminho de configuração (`dataDir`, `cwd`): quem conhece caminho é o adaptador, e o serviço recebe a porta.
- Regra de negócio em adaptador: a regra mora em `domain/` ou no serviço.
- Tipo de domínio com cara de formato em disco: o formato em disco fica em `adapters/fs/data-format.ts`.
- Caso de uso chamando outro via tool: serviço chama serviço ou função pura, nunca uma tool.
- Arquivo de serviço perto do `max-lines` (800): divida antes de bater no teto. `queries/query-service.ts` segue num só `QueryService` de cinco operações; o corte provável é `list` + `readAttachment` em módulos irmãos, com `createQueryService` único, no gatilho de ~650 linhas ou de uma sexta operação de consulta.
- Serviço de escrita gravando em mais de uma porta: a escrita de um `register` é um lote numa só linha de um só processo.
- `queries/` chamando gravação de qualquer porta: leitura só usa os `*Reader`.
- `timeline` somando o projeto contra o teto de 64 MiB por processo (`MAX_LOG_BYTES`): o script lê numa chamada só e o teto vale por processo, não pelo projeto.

Toda violação é achado URGENT.
