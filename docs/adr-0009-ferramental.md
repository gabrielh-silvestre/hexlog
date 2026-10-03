# ADR 0009: Ferramental da 1.0

**Status:** Proposto

**Data:** 2026-10-03

**Deciders:** execução autônoma da F6 (decisões do orquestrador, com respaldo do plano da v1); aguarda aprovação do usuário

---

## Context

A F6 cortou o servidor 0.x e deixou a 1.0 como única árvore. O ferramental em volta do servidor (tools expostas, lock, scripts de leitura, insights e catálogo de erros) ganhou decisões que o plano não fixava ou que a execução desviou. Este ADR as registra.

## Decision

1. **Onze tools.** O servidor expõe exatamente 11 tools. `attach` aceita `text` ou `path` de um arquivo `.md`/`.txt` dentro de `realpath(cwd)` e fora de `realpath(<D>)`; o `cwd` é o teto (com a sessão em `$HOME`, todo `.md`/`.txt` sob ele fica ao alcance e o conteúdo volta ao modelo por `read_attachment`), e só essas extensões entram por não carregarem credencial (`.json`, `.log` e `.env` ficam fora); ampliar esse alcance exige um ADR novo.
2. **Lock por processo e premissa de pid.** Todo servidor que grava em `<D>` roda na mesma máquina e no mesmo namespace de pid. Container ou sandbox dividindo `<D>` faz o `kill(pid, 0)` dar `ESRCH` para dono vivo e o lock vivo ser roubado; a 1.0 não trata isso (voltaria como `pidNs` no `holder`). Reuso de pid no mesmo boot deixa o lock preso até intervenção manual. `holder-unreadable` não é retentável e o destravamento é manual (README, seção "Destravar um processo").
3. **Taxas de `lock-lost` e `lock-busy` aceitas.** Medidas sob 2x de CPU: 2 de 20 rodadas com `lock-lost` e 1 de 20 com `lock-busy` após 15 s. A cadeia segue íntegra e o escritor recebe um erro retentável com a mesma `key`; `moveAside` em `src/adapters/fs/lock.ts` (D-12) não muda. O fixture `test/fixtures/lock-holder.ts`, modo `write`, imprime `retries` para repetir a medição.
4. **Orçamentos só no CI.** `test/adapters/load.budget.spec.ts` compara o mínimo das 5 medições com 500 ms (era a mediana, porque ruído de CPU só soma tempo). Os specs `*.budget.spec.ts` saem do `npm test` e rodam em série em `npm run test:budget`, depois dele no CI.
5. **Scripts de leitura.** `export.ts`, `timeline.ts` e `insights.ts` leem só por `compose.ts` e verificam a cadeia (SL1); nunca importam `src/adapters/**` nem `src/mcp/**` (`eslint.boundaries.js`, `scriptsBlock`, com exceção para `install.ts` e `build.ts`). O contrato novo: `export` emite os campos de `QueryRecord` (sem `seq`, `prevHash` nem `relations`); `timeline` recebe prefixo de target (D-07), tem uma seção por target e não traz linhas `chain` (a leitura de alcance projeto já falha fechada); `PROCESS_CORRUPTED` sai com 2 em `export` e `timeline`. A recusa de dado 0.x vem de `src/errors.ts#legacyDataError`, a mesma do kernel MCP (P11), e `scripts/cli-error.ts#formatCliError` fixa o formato da mensagem e o exit code. A tabela de exit codes está em `scripts/AGENTS.md`.
6. **SE8 no insights.** O `insights` lê os elos crus por `compose#loadProcess`. Duplicata sem chave e percentual de lotes com chave por tipo são exatos (D-04 grava a impressão de todo lote). Chave em excesso segue o G4 do grilling: lote de 1 registro com `key` cuja impressão nenhum outro lote do processo repete. É um proxy: o reenvio com a mesma `key` devolve `replayed` sem gravar (D-06), então "nunca teve reenvio" não é observável no log; medir com exatidão exigiria persistir o `batch-replayed`, que hoje só vai ao stderr. As seções de gates e forks do 0.x saíram, porque `evaluate_gate` não grava mais. O `insights` agrega: dentro de `processReport` continua listando os demais processos quando a leitura de um falha, por isso integridade quebrada sai 1; um `process.json` ilegível derruba a listagem inteira (`query.list({ project })` lê todos os manifestos antes do filtro) e sai 1 com o código impresso. Enumerar processos sem ler o manifesto fica como follow-up.
7. **Catálogo de erros.** `src/errors.ts` mantém 27 códigos (§4.13 do plano). `INVALID_ID` e `UNKNOWN_ID` não são lançados por nada em `src/` na 1.0 e ficam por ora: removê-los leva o catálogo a 25 e exige emendar o plano e o teste que conta os códigos na mesma PR. A decisão de manter ou remover fica aberta para a F8.

## Consequences

- O guard de fronteira dos scripts vive no lint e em `test/boundaries.spec.ts`: import em script não quebra o typecheck.
- A leitura dupla de cada log em `insights.ts#processReport` (`verifyChain` e `loadProcess`) continua. Eliminá-la exigiria o `QueryService` devolver o `VerifiedProcess` junto com o resultado, um contrato compartilhado com a tool MCP; o custo é só tempo num script read-only.
- Alinhar o exit code do `insights` a 2 para integridade quebrada é decisão de produto em aberto.
