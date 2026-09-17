<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-17 | Updated: 2026-09-17 -->

# src

## Purpose
Código-fonte TypeScript do servidor MCP stdio `hexlog`: expõe exatamente 10 tools para agentes registrarem seu histórico de trabalho (Marcos, Vereditos, gates) num log JSONL append-only com cadeia de hash por processo, mais o instalador que versiona o artefato e instala o hook de isolamento Bash no Claude Code.

## Key Files
| File | Description |
|---|---|
| `busca.ts` | Índice de texto MiniSearch sob demanda (§4.17): `textoIndexavel`, `buscar` (AND com fallback OR), filtros estruturados (`ehCandidato`) |
| `cadeia.ts` | Núcleo da cadeia de hash: `sha256hex`, `hashLinha`, `ancora`, `eloValido` (predicado único escritor/verificador), `verificarCadeia` |
| `dados.ts` | I/O de baixo nível: `caminho` (defesa contra path escape), `escreverJsonAtomico` (tmp+fsync+rename), `lerJson`, `erroIo`, nomes reservados |
| `definicoes.ts` | Persistência de tipos/vocabulário/gates custom e do `processo.json` fixado: `registrarTipo` (valida com Ajv2020), `criarProcesso`, `carregarProcesso`, `listarProjetos`, `lerProjeto` |
| `diretorio.ts` | `dirDados(env)`: resolve `$XDG_DATA_HOME/hexlog` ou `~/.local/share/hexlog` |
| `erros.ts` | `ErroHexlog` (classe de erro de domínio com `codigo`/`detalhes`), `CodigoErro` (22 códigos), `detalhesDeIssues` (Zod → JSON Pointer) |
| `estado.ts` | Projeção pura do Estado (§4.8): `projetar` (vigentes/conflitos/órfãos/aRevisar/referenciasInvalidas/avisos), `validarCampo` (vocabulário) |
| `eventos.ts` | Esquemas Zod do envelope de evento e dos tipos nativos: `Linha`, `DadosMarco`, `DadosVeredito`, `DadosMarcoGate`, `analisarId`, `normalizarDados` |
| `ferramentas-definicoes.ts` | Registra as 5 tools de definição: `listar`, `registrar_tipo`, `registrar_vocabulario`, `registrar_gate`, `criar_processo` |
| `ferramentas-eventos.ts` | Registra as 5 tools de eventos: `registrar`, `avaliar_gate`, `estado`, `eventos`, `cadeia` |
| `gates.ts` | Os 4 gates embutidos (`sem-orfaos`, `sem-conflitos`, `cadeia-integra`, `sem-referencias-invalidas`): `avaliarEmbutido`, `montarDadosMarcoGate` |
| `guarda.ts` | Regras de deny + hook PreToolUse em `settings.json`: `regrasEsperadas`, `aplicarGuard`, `verificarGuard`. Puro, só usado por `scripts/instalar.ts` |
| `instalacao.ts` | Instalação versionada do artefato em `~/.local/lib/hexlog/<versão>/`: `instalarArtefato`, `registrarGuard`, `verificarInstalacao`. Puro, só usado por `scripts/instalar.ts` |
| `log.ts` | Append ao JSONL sob lock exclusivo por diretório: `anexar`, `lerTexto`, `adquirirLock`/`liberarLock` |
| `mcp.ts` | Monta o `McpServer`: `criarServidor`, `executar` (envelope de erro + log de toda tool), esquemas Zod compartilhados |
| `servidor.ts` | Ponto de entrada: `serveStdio(() => criarServidor(...))` |
| `tipos-node.d.ts` | Augmentation de `node:crypto` com `randomUUIDv7` (ainda não coberto por `@types/node` 24.8.1) |
| `versao.ts` | `export const VERSAO = '0.1.0'` |

## For AI Agents
### Working In This Directory
- **Cadeia de hash (§4.6):** `hashLinha(l) = sha256hex(l.prevHash + JCS(omit(l, 'prevHash')))`; `ancora(manifesto) = sha256hex(JCS(manifesto))` é a raiz. `eloValido` é o único predicado usado tanto para escrever (`log.ts`) quanto para verificar (`cadeia.ts`) — não duplique essa lógica. A cauda do arquivo sem `\n` final é sempre descartada (`split('\n').slice(0, -1)`).
- **Append-only, sem tool de edição/remoção:** `log.ts` só abre o arquivo em modo `'a'` (append) e faz `fsyncSync` antes de fechar. Não existe tool nem função que reescreva ou remova uma linha do `eventos.jsonl`; qualquer alteração externa é detectada pela tool `cadeia`.
- **Lock por diretório (`log.ts`):** `anexar` cria `<arquivo>.lock/` via `mkdirSync` (falha `EEXIST` se já existe) e grava um token em `owner`. Retry a cada 10ms até 5000ms (`LOCK_TIMEOUT`); lock com `mtime` > 10s é considerado órfão e removido. Antes de escrever, `anexar` confere se o token em `owner` ainda é o seu — senão lança `LOCK_PERDIDO`. A espera é assíncrona; a seção crítica (montar + escrever a linha) é síncrona, sem `await`.
- **Exatamente 10 tools**, fixado em `instalacao.ts` (`QUANTIDADE_TOOLS = 10`) e verificado pelo instalador antes de trocar o artefato: 5 em `ferramentas-definicoes.ts` + 5 em `ferramentas-eventos.ts`.
- **Registro de tool:** toda chamada passa por `executar()` (`mcp.ts`), que nunca deixa uma exceção chegar ao SDK — `ErroHexlog` vira `{codigo, mensagem, detalhes}`, qualquer outra exceção vira `INTERNO` (stack só no log `erro-interno`, nunca na resposta). `executar` também emite sempre um log `tool` com `nome`/`projeto`/`processo`/`ms`/`codigo?`, nunca o conteúdo de `dados`.
- **Convenção de erro (`erros.ts`):** todo erro de domínio é uma instância de `ErroHexlog` com um dos 22 códigos de `CodigoErro` (ex.: `ENTRADA_INVALIDA`, `ID_CONFLITANTE`, `VOCABULARIO_VIOLADO`, `LOCK_TIMEOUT`). Erros de validação Zod viram `detalhes[]` via `detalhesDeIssues`, com `caminho` em formato JSON Pointer (RFC 6901).
- **Nomes reservados:** `marco`/`veredito` como nome de tipo, `schemas`/`vocabulario`/`gates` como nome de processo, e os 4 nomes de gate embutido — todos rejeitados com `NOME_RESERVADO` (`dados.ts`).
- **Módulos de instalação são puros e isolados:** `guarda.ts` e `instalacao.ts` não são importados por `servidor.ts` nem pelo hook; só por `scripts/instalar.ts` (fora de `src/`). Toda execução externa (spawn do hook, subida do servidor, relógio) entra por parâmetro injetado — nunca chamada direta a `child_process`/`Date.now` dentro da lógica testável.

### Testing Requirements
```sh
npm test          # jest: testa o .ts fonte diretamente
npm run typecheck # tsc --noEmit
npm run build     # esbuild -> bundles .mjs (mesmo passo 1 do instalador)
```
- `npm ci` precisa ser completo (sem `--omit=dev`): `esbuild` e `@modelcontextprotocol/client` são dependências de desenvolvimento usadas pelo instalador/testes.
- Specs em `test/` espelham os módulos: `cadeia.spec.ts`, `busca.spec.ts` + `busca.orcamento.spec.ts`, `definicoes.spec.ts`, `diretorio.spec.ts`, `estado.spec.ts` + `estado.property.spec.ts` (fast-check), `eventos.spec.ts`, `ferramentas-definicoes.spec.ts` (cobre também `mcp.ts`), `ferramentas-eventos.spec.ts`, `gates.spec.ts`, `guarda.spec.ts` (cobre também `instalacao.ts` e `servidor.ts`), `guarda-bash.spec.ts`, `log.spec.ts`, `pacote.spec.ts`, `toolchain.spec.ts`.
- `stdio.e2e.spec.ts` sobe o servidor a partir do bundle `.mjs` já construído — é o único jeito de testar o artefato que as sessões de fato executam. Rode `npm run build` antes se o teste e2e depender de um bundle atualizado.

### Common Patterns
- Toda escrita em `schemas/`, `vocabulario/`, `gates/` e `processo.json` usa `escreverJsonAtomico`/`criarArquivoExclusivo` (`dados.ts`/`definicoes.ts`): arquivo temporário no mesmo diretório, `fsync`, depois `rename`/`link` — nunca escrita direta no arquivo final.
- Hash de conteúdo sempre por `sha256hex(canonicalize(valor) ?? '')` (JCS): mesmo padrão em `cadeia.ts`, `definicoes.ts` e na comparação de idempotência de `registrar` (`ferramentas-eventos.ts`).
- Toda função pura que decide algo (`avaliarEmbutido`, `projetar`, `verificarCadeia`, `buscar`) recebe dados já carregados e devolve um valor — nenhuma delas faz I/O; o I/O fica nas bordas (`log.ts`, `dados.ts`, `definicoes.ts`).
- Toda lista de saída tem teto e devolve o total real ao lado (ex.: `quebras`/`linhasReparadas` em 100, seções de `estado` em 100, `eventos` por página de 24.000 caracteres canônicos).
- `isNil`/`isNotNil`/`isEmpty` (es-toolkit) em vez de checagem manual de `undefined`/`null`/comprimento, em todo o código.

## Dependencies
### Internal
Ponto de entrada: `servidor.ts` → `diretorio.ts` (resolve dir de dados) + `mcp.ts` (`criarServidor`).
`mcp.ts` registra as tools chamando `ferramentas-definicoes.ts` e `ferramentas-eventos.ts`, e fornece a ambos o envelope `executar()` e os esquemas Zod comuns.
`ferramentas-definicoes.ts` chama `definicoes.ts` (persistência) e `gates.ts` (lista de gates embutidos).
`ferramentas-eventos.ts` é o módulo mais conectado: chama `definicoes.ts` (carregar processo), `log.ts` (`anexar`/`lerTexto`), `cadeia.ts` (`eloValido`/`verificarCadeia`), `estado.ts` (`projetar`), `gates.ts` (avaliação), `busca.ts` (modo busca) e `eventos.ts` (validação/normalização de `dados`).
`definicoes.ts`, `cadeia.ts`, `log.ts`, `estado.ts`, `gates.ts` e `busca.ts` dependem de `eventos.ts` (esquema `Linha`) e `erros.ts` (`ErroHexlog`); `dados.ts` é a base de I/O usada por `definicoes.ts`.
`guarda.ts` e `instalacao.ts` formam um subgrafo isolado (instalação), consumido só por `scripts/instalar.ts` fora de `src/`.

### External
| Pacote | Uso em `src/` |
|---|---|
| `@modelcontextprotocol/server` | `McpServer`, `serveStdio` — servidor MCP e registro de tools (`mcp.ts`, `servidor.ts`, `ferramentas-*.ts`) |
| `zod` | Esquemas de validação de entrada/saída de toda tool e dos eventos (`eventos.ts`, `mcp.ts`, `estado.ts`, `gates.ts`, `ferramentas-*.ts`) |
| `canonicalize` | Serialização JCS para hash determinístico (`cadeia.ts`, `definicoes.ts`, `eventos.ts`, `ferramentas-eventos.ts`) |
| `ajv` (`ajv/dist/2020.js`) + `ajv-formats` | Valida schema JSON custom antes de aceitar em `registrar_tipo` (`definicoes.ts`) |
| `minisearch` | Índice de texto do modo busca de `eventos` (`busca.ts`) |
| `es-toolkit` (+ `es-toolkit/compat`) | Utilitários (`isNil`, `isEmpty`, `groupBy`, `keyBy`, `pick`, `uniqBy`, `omit`, `orderBy`, `round`, `get`) usados em quase todo módulo |
| `jsonc-parser` | Parse/edição de `settings.json` preservando comentários/formatação (`guarda.ts`) |
| `shell-quote` | Parse/quote do `command` do hook PreToolUse (`guarda.ts`) |

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
