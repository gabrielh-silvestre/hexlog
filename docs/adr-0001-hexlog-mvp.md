# ADR 0001: hexlog MVP

**Status:** Aceito

**Data:** 2026-09-16

**Deciders:** Gabriel Henrique Silvestre Baldino; planejamento RALPLAN iterações 1–3

---

## Context

O hexlog é um servidor de eventos estruturados focado em rastreabilidade, auditoria e integração com o Claude Code MCP. A necessidade surge de centralizar logs de execução, permitir reconstrução de estado por timestamp e oferecer primitivas de busca e validação via schema.

A POC (`POC:`, commit **`5703a53`**, branch `poc-motor-log` do repo `/home/gabriel/personal/core`) provou o conceito em 27 commits e deixa como legado a semântica de cadeia, marco, porta e supersessão. O MVP aqui mira em estabilizar o formato, instalar o artefato como MCP, e validar a integração com Claude Code em sessão real.

## Decision

Construir o hexlog MVP como servidor MCP ESM em Node 24, com:

- **Servidor principal:** arquivo único `servidor.mjs` (esbuild, ~65 ms), entrado pelos CLientes MCP
- **Hook de isolamento:** `guarda-bash.mjs` (hook instalado via `~/.claude/settings.json`), nega operações em diretórios protegidos
- **Log estruturado:** arquivo `processo.jsonl`, append-only, validado por schema Zod
- **Cadeia criptográfica:** cada evento carrega `hash` do envelope anterior; mudança em qualquer evento quebra a cadeia (detectável)
- **Busca:** cursor estável com `ate`, fallback OR em linguagem natural
- **Spec:** contrato YAML (`spec-VERSÃO.yaml`) com vocabulário, tipos de evento, critérios de gate
- **CLI:** removida no passo final (G1); a instalação e o servidor bastam
- **Teste:** ts-jest em transform CJS, fixture real com 4 servidores stdio, barreira determinística para concorrência

## Alternatives Considered

1. **Organização hexagonal ou multi-pacote:** Preterida. MVP é um servidor, não framework; complexidade desnecessária.

2. **CJS + `.mts`, preset ESM do ts-jest ou build `dist/`:** O `type: module` (ESM nativo) + `.ts` direto no Node 24 (type stripping) prova-se mais rápido (183 ms no bundle vs. 407 ms no `.ts` servido) e dispensa build de debug.

3. **Hook compilado ou em Go:** Não vale a indireção de linguagem; Bash com regex é direto.

4. **Logging com lib (pino, LogTape 2.3.5, consola, tslog):** Preterido. Apenas console e arquivo estruturado; lógica de filtro vai para follow-up.

5. **Ecossistema do zod (zod-schema-faker, zod-fast-check):** Preterido. Property-based com `fast-check` já cobre, valores extremos são mais legíveis com fixture explícita.

6. **UUID externo (`uuid@14.0.2`):** Substituído. Node ≥ 24.16.0 traz `crypto.randomUUIDv7()` nativo.

7. **Bundle em CJS (`.cjs`) ou sem build (`.ts` direto):** Alternativas documentadas. ESM escolhido por semântica vencedora, fallback para CJS se dep futura quebrar.

## Consequences

- **Append e leitura são O(n).** A validação inteira do arquivo é feita a cada operação. Cursor estável (campo `ate`) mitiga em buscas. Escalável até ~100k linhas por processo.

- **Retentativa com id completo não duplica.** Garantia de idempotência: o servidor valida via lock.

- **Erro de forma chega como texto do SDK.** O MCP não transporta schemas de erro; validação Ajv é traduzida para string.

- **Falha do hook instalado abre o isolamento em silêncio** até alguém rodar `--check` (R-1 do plano). A working tree deixou de ser causa; o guard é um arquivo estático em `~/.local/lib/hexlog/guarda-bash.mjs`.

- **Existe um passo de build e instalação.** Mudança de código só chega às sessões rodando `node scripts/instalar.ts`. O artefato instalado pode ficar desatualizado (aviso `artefato-desatualizado`); versões antigas acumulam em `~/.local/lib/hexlog/`.

- **O bundle ESM depende de nenhuma dep CJS fazer `require` dinâmico de builtin.** Se acontecer, fallback nomeado: `banner` com `createRequire(import.meta.url)`, depois CJS.

- **A busca custa O(n) por chamada** (~250 ms em 10k linhas). Cursor estável quando o agente reenvia `ate`; sem `ate`, um append entre páginas desloca itens.

- **Consultas em linguagem natural caem no fallback OR,** com resultado mais frouxo, sinalizado por `combinacao: 'OR'`.

- **Filtro `resultado` sem validação:** digitação errada devolve lista vazia, sem erro.

- **Não há filtro por id de evento.** Busca textual não encontra ids nem endereços.

- **O artefato instalado continua gravável por Bash/subprocesso** (lacuna aceita, QN4 do plano). Alteração que mude bundle e manifesto de forma consistente só aparece como `artefato-desatualizado`.

- **`canonicalize` e zod fazem parte do formato do log.** A âncora é o hash canônico do arquivo inteiro; mudar a canonicalização invalida a âncora de todos os processos existentes.

- **`@types/node` exige augmentation para `randomUUIDv7`.** Em Node < 24.16, o import falha no link ESM e o servidor não sobe: falha explícita, aceitável com `engines >=24.18.1`.

- **Logs da POC são incompatíveis** com o formato novo (novo `seq`, novo hash, novo vocabulário).

- **A POC deixa de existir.** 27 commits, `.ignore/`, `.omc/` e artefatos perdidos por decisão explícita (D14). Toda citação `POC:arquivo:linha` vira histórica ("POC@5703a53, removida").

- **Os PRs #63/#64/#66 do weed-clicker quebram** e serão tratados depois; mudanças não commitadas do #63 ficam intactas na worktree dele.

- **O manifesto `processo.json` faz parte do formato do log.** Uma mudança na forma do manifesto ou canonicalização invalida a âncora de todos os processos existentes.

- **Falsos positivos do hook a partir do home** (`ls ~/**/*.md`, `ls ~/{docs/a,b}`) são aceitos (R-6).

## Opção Vencedora do Passo 0

**Jest config f1c (type stripping, ts-jest CJS transform, moduleNameMapper):** provada em primeira, sem fallback. O bundle ESM via `esbuild 0.28.2` com `--format=esm`, saída `servidor.mjs` e `guarda-bash.mjs`, zero banner/CJS. A augmentation de `randomUUIDv7` reside em `src/tipos.ts` via `declare module "crypto"`.

## POC Arquivada

A worktree `core.poc-motor-log` (branch `poc-motor-log` do repo `/home/gabriel/personal/core`) congelada no commit **`5703a53`** serviu de prototipagem. Nenhum import direto do código da POC para o MVP; todo porte de comportamento e teste termina antes do passo 16 (passos 2–7b). As decisões D2, D3, D9 herdaram semântica (cadeia, canonicalização, alvo) mas implementação é nova.

A POC será removida no passo 16 via `wt remove -D -f` após validação em sessão real (R1) e remoção da CLI (G1). Nenhum bundle ou tar: só o SHA `5703a53` fica registrado aqui, como referência histórica.

## Testes Portados da POC

Os casos de teste abaixo foram adaptados da POC (`POC@5703a53`) para o MVP. Cada linha cita o arquivo e linhas da POC; a coluna "Destino" nomeia o spec do hexlog que implementa o comportamento.

| POC@5703a53 (arquivo:linha) | Comportamento | Destino | Adaptação |
|---|---|---|---|
| `poc/test/evolve.spec.ts:11` | Estado bate com o fixture | `estado.spec` | Fixture no envelope novo, alvos `hex:alvo:*` |
| `evolve.spec.ts:32,38` | Pureza; rebuild = incremental | `estado.spec` | — |
| `evolve.spec.ts:55` | Duplicata por id não muda o Estado | `estado.spec` | — |
| `evolve.spec.ts:69,76,85,96` | Avisos por dono | `estado.spec` (N4) | Vocabulário `{nucleo, porDono}` |
| `evolve.spec.ts:113,120,127` | Hash do vocabulário | `definicoes.spec` | JCS ordena chaves |
| `evolve.spec.ts:136` | aRevisar | `estado.spec` | Refs por id |
| `evolve.spec.ts:163,171,182` | Órfãos (log, a tempo, parede) | `estado.spec` | `agora = max(injetado, log)` (Q10) |
| `evolve.spec.ts:195,204,217` | Cadeia íntegra; byte alterado; 1ª linha | `cadeia.spec` | `predecessor-ausente` → `seq-divergente`/`hash-nao-bate` no 1º elo; âncora |
| `poc/test/supersessao.spec.ts:14,23,35,51,68,90` | Supersessão completa | `estado.spec` (N3) | `supera` por id (Q2) |
| `poc/test/evolve.property.spec.ts:77,94,137,158` | Propriedades | `estado.property.spec`, `cadeia.spec` | Ids no formato novo |
| `poc/test/gate.spec.ts:22,31,41` | Contrato do gate | `gates.spec` | `condicao` → `criterio` |
| `poc/test/motor.spec.ts:49,63,78,84,95,104,114,127,145` | Ciclo do Marco | `estado.spec › ciclo` | Função pura; Marco de gate ignorado (R-3) |
| `motor.spec.ts:137` | Alvo inválido recusado sem linha | `ferramentas-eventos.spec › N12` | Regex `hex:alvo:` (Q1) |
| `poc/test/append.spec.ts:34,40,47,57,65,79,92,107,188` | Store e lock | `log.spec` | Sem Port/adapter; âncora |
| `append.spec.ts:140,220` | 2 processos | `stdio.e2e.spec › C1` | 4 servidores + barreira |
| `append.spec.ts:252,271,288,310` | Linha fora do schema → `.rejected.jsonl` | `cadeia.spec`, `ferramentas-eventos.spec › N1` | `linha-invalida`/`dados-invalidos` + `eventos.linhasInvalidas` |
| `append.spec.ts:328,346,359` | Disco = memória; adulteração | `ferramentas-eventos.spec › N1` | Via tool `cadeia` |
| `poc/src/cli/operacoes.ts:217-285` | Validação na escrita, vocabulário, id divergente | `ferramentas-eventos.spec › N2, N4, N9` | Comparação normalizada |

## Divergências em Relação à Pesquisa

- **UUID:** A pesquisa recomendava `uuid@14.0.2` (lib externa). Substituído por `crypto.randomUUIDv7()` nativo (Node ≥ 24.16.0), verificado em 24.18.1. Reduz dependências e alinha com preferência nativa.

## Decisões do Usuário

Resumo das decisões Q, R, QN, U do plano (linhas 141–192 de ralplan-hexlog.md):

| ID | Decisão |
|---|---|
| Q1 | Alvo segue `hex:alvo:<id>` validado por regex, sem import |
| Q2 | `supera` usa ids completos |
| Q6 | Remover POC no passo 16 (worktree + branch) |
| Q8 | Passo 14 do plano (confirmação da instalação) requer aprovação do usuário |
| Q9 | Hook nega operações em `~/.local/lib/hexlog` |
| Q10 | Tempo do evento = `max(injetado, log)` |
| R-1 | Falha do hook instalado não bloqueia a sessão; `--check` recupera |
| R-3 | Marco de gate é reservado, não abre/fecha ciclo |
| R-5 | Worktree da POC é removida no passo 16 |
| R-6 | Falsos positivos do hook a partir do home são aceitos |
| R-7 | Confirmação do usuário obrigatória para remoção (passo 16) |
| QN2 | PRs #63/#64/#66 do weed-clicker quebram; tratamento posterior |
| QN3 | Filtro `resultado` sem validação; digitação errada = lista vazia |
| QN4 | Artefato instalado continua gravável por Bash (lacuna aceita) |
| QN5 | Sem filtro por id de evento |
| U-1 | MCP como runtime (C-1) |
| U-3 | Zod para schema; sem `zod-schema-faker` |
| U-4 | Logging com console e arquivo; LogTape 2.3.5 em follow-up |
| U-5 | Effect reavaliar conforme gatilho registrado |
| U-7 | Bundle ESM `.mjs` via esbuild, sem binário externo |
| U-8 | Working tree deixou de ser causa de falha do hook |

## Decisões de Execução

Decisões tomadas durante a execução (Ralph, iterações 1–3):

- **DE-09:** `jsonc-parser` removido do bundle de probe (passo 0), evita shim dinâmico que reprova validação estática.
- **DE-13:** Sandbox nativo do Claude Code fica fora (usuário).
- **DE-14:** Revoga non-goal "Apagar código da POC"; substitui G2 da spec. No passo 16, `wt remove -D -f` apaga worktree e branch, descartando 27 commits, `.ignore/`, `.omc/` e `node_modules`. Só SHA `5703a53` fica registrado aqui.
- **DE-16:** Arquivo `src/versao.ts` criado no passo 0 (probe precisa do módulo real).
- **DE-17:** Guard de entrypoint (`src/entrypoint.ts`) implementado com detecção de latência; hook falha aberto (R-1).

## Verificações Reais Pendentes

Os passos 12–16 do plano ficam como pendências do usuário:

- **Passo 12:** Instalação real do MCP (`npm test` verde, backup de `~/.claude/settings.json`, `npm run instalar`). Reversível via backup + `claude mcp remove`.
- **Passo 13:** Isolamento em sessão real (validar deny do hook em uma session isolada).
- **Passo 14:** Confirmação do usuário (contrato e consequências do passo 15). Obrigatório.
- **Passo 15:** Testes reais no weed-clicker (R1 — validar que as tools funcionam na prática).
- **Passo 16:** Remoção da CLI (G1, reversível com `npm run instalar` novamente) e remoção da worktree/branch da POC (G2, **irreversível**; apaga 27 commits). Exige confirmação explícita (R-7).

Todas as mudanças de código (passos 0–11) foram concluídas. A POC congelada em `5703a53` está pronta para arquivamento.
