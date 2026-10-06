# Instalação e hooks

## Instalador

- `node scripts/install.ts` escreve em `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/`. Não rode sem pedido explícito. `--check` só verifica e não toca em nada.
- Com dado 0.x em `<D>`, sem flag o instalador só lista o que arquivaria e sai 2; `--archive-0x` arquiva em `<D>/archive/` e segue para a instalação (`src/archive.ts`; recusas e retomada em `docs/migracao.md`, seção "Dado 0.x"). Ponto de retorno e arquivamento: [ADR 0009](adr-0009-ferramental.md), itens 8, 9 e 15.
- Só Linux: o arquivador e o lock dependem de `/proc`, hard link e `fsync` de diretório. macOS não foi testado.
- Mudar `hook/bash-guard.ts` ou `src/server.ts` na working tree não afeta sessão nenhuma, em andamento ou nova, até rodar `node scripts/install.ts` de novo: as sessões executam a cópia versionada em `~/.local/lib/hexlog/<versão>/`.
- Os 2 bundles (`server`, `bash-guard`) são um conjunto fixo e nomeado (tipo `Bundles` em `src/installation.ts`): um terceiro entrypoint exige tocar `scripts/build.ts`, `Bundles`, `installArtifact` e `verifyInstallation`.
- As skills são dinâmicas: o instalador copia toda pasta de `skills/` (`skillNames()` lê as pastas, `writeSkillFolder` troca cada uma em `~/.claude/skills/<nome>/` por `swapDirectory`, sem backup). Uma skill nova só precisa de `skills/<nome>/SKILL.md` para ser instalada e conferida pelo `--check`; não toca `scripts/install.ts`.

## Hook de isolamento (`hook/bash-guard.ts`)

- É buildado pelo esbuild (entrada `bash-guard`, saída `dist/bash-guard.mjs`); o `.mjs`, não a working tree, é o que o instalador copia e registra em `~/.claude/settings.json` com `matcher: '^Bash$'`.
- Só tokeniza o comando recebido; nunca executa nada. Nega (exit 2) o que alcança o diretório de dados e **falha aberto** em qualquer exceção, `node` ausente ou entrada inválida.
- A mensagem de negação é um literal (`hook/bash-guard.ts#denialMessage`) e cita os nomes das tools de leitura; trocar uma tool de nome troca a mensagem junto ([ADR 0009](adr-0009-ferramental.md), item 16).
- O hook cobre o acesso a `<D>` por Bash. Não cobre outras ferramentas: o limite de isolamento está em `docs/dados.md`.

## Hooks do projeto para o fluxo

Definidos no [ADR 0010](adr-0010-camada-sobre-omc.md), itens 3 a 5, em `.claude/settings.json` do projeto (não nos bundles do produto).

- O marcador do pré-PR é verificação de processo, não barreira de segurança: um agente com `Write` ou `Bash` o forja. O freio pega o descuido, não a burla.
- O hook de PR só decide sobre o que casa. Entrada que não consegue ler, exceção ou marcador ausente em abertura de PR bloqueiam (exit 2); comando de Bash sem relação com PR passa.
- Sem `node` o hook de Bash falha aberto, para não travar toda chamada de Bash; o limite conhecido é que `gh pr create` passa nesse caso.
- Não cobre `gh api` nem push que cria PR.
- O hook não lê o log do hexlog, para não se acoplar ao formato em disco.
- Nenhum hook do hexlog usa `updatedInput` no tool `Agent`: o context-mode e o OMC já reescrevem esse input, e um terceiro hook pode apagar o que os outros puseram sem erro visível.
