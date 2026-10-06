<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-10-06 | Updated: 2026-10-06 -->

# directives

## Purpose
Diretrizes do hexlog: os docs vivos de regras, importados pelo `CLAUDE.md`, e os ADRs da 1.0. As regras de ADR (só emenda, nunca reescrita) e de doc vivo estão em `documentacao.md`.

## Key Files
| File | Description |
|---|---|
| `convencoes.md` | Doc vivo: idioma, núcleo e bordas, dependências, hash JCS e hash de bytes, tetos de lista, escrita atômica, import padrão de `fs` e `import()`. |
| `fronteiras.md` | Doc vivo: mapa de camadas, direção permitida de dependência, travas mecânicas e checklist de review (violação é URGENT). |
| `invariantes.md` | Doc vivo: log append-only e predicado único, cadeia, lock, 11 tools e `execute()`, erros, anexos e versionamento de definições, com o item de ADR de cada um. |
| `qualidade-e-testes.md` | Doc vivo: comandos antes de concluir, orçamentos só no CI, convenções dos specs, bundle por processo filho e fixtures. |
| `documentacao.md` | Doc vivo: ADR e doc vivo, ADR só por emenda, como citar, `pesquisa/` congelado, famílias de ID e o papel do `AGENTS.md`. |
| `fluxo-hexlog.md` | Doc vivo, importado em primeiro no `CLAUDE.md`: regras de uso do registro de trabalho — processos e targets, quando uma escolha vira `decision`, confiança, `gap` (só `directive` fecha), `verification`, `finding` e achado URGENT, gates `pre-pr` e `gaps` e PR em rascunho. |
| `instalacao-e-hooks.md` | Doc vivo: instalador, bundles fixos e skills dinâmicas, hook de isolamento e hooks do projeto para o fluxo (o que cada um cobre e não cobre; o marcador não é barreira de segurança). |
| `adr-0007-dominio.md` | ADR 0007, status Aceito: domínio da 1.0 — catálogo de entidades, regra "`supersedes`/`revokes` só no processo", vigência e conferência do destino de `supports`, `revokes` sobre não vigente recusado com `FORK_REJECTED`, anexo por palavra-chave de schema e guarda `unmarked-attachment`, versionamento (gate sem detecção de quebra, processo novo depois de `breaking: true`) e as quatro perguntas de gate (21 decisões numeradas). |
| `adr-0008-servicos.md` | ADR 0008, status Aceito: serviços da 1.0 — emendas às specs (vigência só no processo, lock só da origem, E5 e `CYCLE_REJECTED`, cursor, teto de `text` e a reversão do "sem cache"), reavaliação do lock, precedência dos erros do `register` em seis níveis (D-06), regra de leitura D-24, ordem de saída da `query`, cegueira do alcance processo e reprodução do gate só pelo marcador (D-19) e limites aceitos da busca (7). |
| `adr-0009-ferramental.md` | ADR 0009, status Aceito: ferramental da 1.0 (tools expostas, lock, scripts de leitura, catálogo de erros, ponto de retorno e arquivamento do 0.x, limites aceitos do validador e do anexo), em itens numerados; a numeração só cresce, e os ADRs e esta pasta citam item por número. |
| `adr-0010-camada-sobre-omc.md` | ADR 0010, status Aceito: como as regras de uso do hexlog valem por cima do OMC, na sessão principal e nos subagentes — skill de entrada fina, doc de regras importado no `CLAUDE.md`, ponteiro no `SubagentStart`, bloqueio da abertura de PR sem marcador do pré-PR (emenda de 2026-10-06: cobre também `gh pr ready` e `update_pull_request` com `draft: false`) e nenhuma reescrita do prompt do `Agent`. |

## Navigation Notes
- Os ADRs citam `../tetos-dominio-v1.md` (nos ADRs 0008 e 0009); `test/directives.spec.ts` confere que todo link relativo da pasta resolve.
