# Documentação

## Dois tipos de documento

- **ADR** (`docs/directives/adr-*.md`): registra uma decisão com trade-off real. É imutável depois de Aceito.
- **Doc vivo** (os demais `.md` de `docs/directives/`): regra de trabalho, editável como código. Lacuna de regra vira linha num doc vivo; só trade-off real vira ADR.
- `AGENTS.md` de cada pasta é navegação (Purpose, Key Files, Subdirectories, Dependencies e fatos de como o código é). Regra não mora nele: ele só liga, em `## Diretrizes`, aos docs vivos. Essa seção e todo texto manual ficam **abaixo** do título `## Manual Notes`, porque a regeneração (`/deepinit`) reescreve o que está acima. A linha `**Parent context:**` e as datas de geração ficam em prosa visível, nunca em comentário HTML, que o Claude Code descarta antes de o agente ler.

## ADR

- A partir da 1.0, ADR não é refeito nem apagado, só recebe emenda: uma seção nova ("Amendment") ou um ADR seguinte (`adr-000N-...md`), sem reescrever Decision nem Consequences já registrados ([ADR 0009](adr-0009-ferramental.md), item 17).
- Na aprovação só o cabeçalho muda (Status passa a Aceito e Deciders inclui quem aprovou). Depois de Aceito, o corpo só muda por emenda datada.
- O ADR 0001 está só no git (`git show 87237c3:docs/adr-0001-hexlog-mvp.md`).
- Antes de trocar uma lib ou uma decisão, confira [ADR 0007](adr-0007-dominio.md), [ADR 0008](adr-0008-servicos.md), [ADR 0009](adr-0009-ferramental.md), a frente correspondente em `docs/pesquisa/frentes/` e `docs/pesquisa/hexlog-pesquisa-libs.md`: a maioria das alternativas já foi avaliada e tem motivo registrado.

## Changelog

- `CHANGELOG.md` segue o Keep a Changelog em pt-BR: `[Não lançado]` no topo e, por versão, as seções Adicionado, Alterado, Corrigido e Removido, nessa ordem, mais Migração só quando a versão quebra ou muda comportamento. Uma linha por mudança visível a quem usa o hexlog, com o número do PR; refactor, teste e doc interna ficam fora.
- **Número da versão.** O contrato público é o que o agente enxerga: entradas e formato padrão das 12 tools, códigos de erro e formato em disco. Quebra desse contrato que a Migração cobre (parâmetro que devolve o formato antigo, ou passo escrito para o agente) sai em minor, e a seção abre com uma frase que nomeia a quebra. Major fica para o que a Migração não cobre: formato em disco incompatível, tool removida ou renomeada, código de erro removido ou renomeado.
- O job `changelog-line` (`.github/workflows/changelog-line.yml`) barra o PR para `develop` que traz commit `feat`, `fix`, `perf` ou `revert` (menos os escopos `flow` e `claude`) sem linha nova em `[Não lançado]` citando o `#N` do próprio PR. PR do Dependabot e `chore/back-merge-*` do próprio repositório (`head.repo.full_name == github.repository`) pulam o job.
- A seção da versão nasce no mesmo commit do bump de `package.json#version`; `test/changelog.spec.ts` trava.
- O rascunho sai de `npx git-cliff --unreleased` (`cliff.toml`), e o workflow `changelog-draft.yml` o comenta no PR para `main`. O rascunho é ponto de partida: reescreva em linguagem de usuário e escreva a Migração à mão.
- O merge do PR de release em `main` roda `.github/workflows/release.yml`: cria a tag `vX.Y.Z`, o GitHub Release e o PR de back-merge para `develop` (`chore/back-merge-vX-Y-Z`), sem passo manual; a reexecução só cria o que falta. O corpo do Release sai de `scripts/release-notes.ts#releaseNotes`: o parágrafo de abertura é o texto da seção `## [X.Y.Z]` do `CHANGELOG.md` antes do primeiro `###` (escreva o resumo da versão ali, no PR de release), seguido de "PR da release: #N", das subseções da versão (`###` vira `##`) e do bloco de instalação, literal no script. Sem parágrafo de abertura, só a linha do PR.
- Hotfix em `main` também sobe `package.json#version`: o passo `Tag` do `release.yml` compara o commit da tag existente com o do push e falha se divergem, porque sem isso o job sairia 0 sem abrir o back-merge e o commit não voltaria para `develop`. A reexecução do mesmo push passa, pois a tag já aponta para o commit.
- Da abertura do PR de release até o merge do back-merge, não entre `feat` nem `fix` novo em `develop`. Se entrar, o back-merge conflita no `CHANGELOG.md` (resolva mantendo as duas seções) ou mescla limpo com a linha caída sob `[X.Y.Z]`; o segundo caso é silencioso, então confira `[Não lançado]` depois do back-merge e mova a linha para lá.

## Como citar

- Documentação (`.md`) e comentários citam arquivo e símbolo, nunca número de linha; `test/skill-coherence.spec.ts` trava a regra nos `.md`.
- Nas skills o formato é `caminho/arquivo.ts#símbolo`, com o caminho relativo a `src/` (ex.: `mcp/kernel.ts#execute`), conferido contra `src/`.
- Link entre `.md` é relativo, e `test/directives.spec.ts` confere que todo link, todo `@` do `CLAUDE.md` e toda citação de arquivo com título de seção em crase resolvem.

## `docs/pesquisa/`

Está congelado desde 2026-09-28, inclusive os `AGENTS.md` de lá: não edite esses arquivos, nem para corrigir, anotar ou emendar, e a revisão de doc contra o código os ignora. O ADR 0001 foi substituído pelos ADRs 0007 a 0009, e os links de `pesquisa/` para ele ficam mortos de propósito. Mudança de rumo sobre o que o ADR 0001 decidiu vai num ADR novo.

## Famílias de ID

IDs de decisão remetem a decisões do usuário ou de execução tomadas durante o planejamento e vêm em duas famílias, nenhuma delas definida nos ADRs:

- 0.x (`Q#`, `QN#`, `R-#`, `U-#`, `DE-##`, `M#`, `N#`, `S#`, `B#`, `I#`, `C#`): definidos só no ADR 0001, removido na F8; leia no commit `87237c3` (ancestral da `main`, estável): `git show 87237c3:docs/` lista os ADRs da época.
- 1.0 (`D-##`, `E#`, `G#`, `L#`, `f#`, `Constraint N`, `P#`, `TM#`, `TB#`, `TF#`, `SL#`, `SE#`): vivem nas specs e no plano em `.omc/` do checkout principal (não nas worktrees), ignorado pelo git. Só `D-##` tem sentido inline, nos ADRs 0008 e 0009 e em [tetos-dominio-v1.md](../tetos-dominio-v1.md); os demais ficam como rótulo sem destino versionado, porque o dono decidiu não versionar as specs nem o plano da 1.0.
- Código, comentários e testes não citam `§N.N`. Não crie rótulo novo dessas famílias: decisão nova vira item numerado de ADR, por emenda. Os IDs nos títulos de teste remetem a essas famílias, não aos ADRs.
