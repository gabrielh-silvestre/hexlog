<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-10-06 | Updated: 2026-10-06 -->

# directives

## Purpose
Decisões do hexlog que valem como regra: os ADRs da 1.0. A regra de ADR (só emenda, nunca reescrita) está em `../AGENTS.md`, seção "Working In This Directory".

## Key Files
| File | Description |
|---|---|
| `adr-0007-dominio.md` | ADR 0007, status Aceito: domínio da 1.0 — catálogo de entidades, regra "`supersedes`/`revokes` só no processo", vigência e conferência do destino de `supports`, `revokes` sobre não vigente recusado com `FORK_REJECTED`, anexo por palavra-chave de schema e guarda `unmarked-attachment`, versionamento (gate sem detecção de quebra, processo novo depois de `breaking: true`) e as quatro perguntas de gate (21 decisões numeradas). |
| `adr-0008-servicos.md` | ADR 0008, status Aceito: serviços da 1.0 — emendas às specs (vigência só no processo, lock só da origem, E5 e `CYCLE_REJECTED`, cursor, teto de `text` e a reversão do "sem cache"), reavaliação do lock, precedência dos erros do `register` em seis níveis (D-06), regra de leitura D-24, ordem de saída da `query`, cegueira do alcance processo e reprodução do gate só pelo marcador (D-19) e limites aceitos da busca (7). |
| `adr-0009-ferramental.md` | ADR 0009, status Aceito: ferramental da 1.0 (tools expostas, lock, scripts de leitura, catálogo de erros, ponto de retorno e arquivamento do 0.x, limites aceitos do validador e do anexo), em itens numerados; a numeração só cresce, e os ADRs e esta pasta citam item por número. |
| `adr-0010-camada-sobre-omc.md` | ADR 0010, status Aceito: como as regras de uso do hexlog valem por cima do OMC, na sessão principal e nos subagentes — skill de entrada fina, doc de regras importado no `CLAUDE.md`, ponteiro no `SubagentStart`, bloqueio da abertura de PR sem marcador do pré-PR e nenhuma reescrita do prompt do `Agent`. |

## For AI Agents
### Working In This Directory
- Os ADRs citam `../tetos-dominio-v1.md` (nos ADRs 0008 e 0009); `test/directives.spec.ts` confere que todo link relativo da pasta resolve.
