# Instalação

Requisitos, instalação, verificação e como reverter. O resumo está no [README](../README.md).

## Requisitos

- Linux. O lock por pid, a gravação atômica e o arquivador dependem de `/proc`, de hard link e de
  `fsync` de diretório (`src/adapters/fs/atomic.ts#writeFileAtomic`): macOS não foi testado, e
  Windows, FAT, exFAT e drvfs (`/mnt/c` no WSL) ficam fora. O diretório de dados `<D>` precisa de
  hard link e de `rename`/`link` atômicos: ver [Layout de dados](dados.md#layout-de-dados).
- Node `>= 24.18.1`.
- Claude Code, com `~/.claude/settings.json` já existente (o instalador grava
  nele; harness não instalado = instalação falha com uma mensagem explícita).

## Instalação e atualização

```sh
npm ci
npm test
node scripts/install.ts
```

O `npm ci` precisa ser completo, sem `--omit=dev`: o instalador usa `esbuild`
e `@modelcontextprotocol/client`, que são dependências de desenvolvimento.

`node scripts/install.ts` faz quatro coisas:

1. Constrói o servidor e o hook com `esbuild` e verifica o artefato preparado
   antes de trocar qualquer coisa (o hook precisa negar o diretório de dados e
   permitir o resto; o servidor precisa subir e anunciar as 12 tools).
2. Copia os dois bundles (servidor, `bash-guard`) para `~/.local/lib/hexlog/<versão>/`,
   fora da working tree e fora do diretório de dados. É essa cópia que as sessões
   executam.
3. Registra as 4 regras de deny e o hook PreToolUse em
   `~/.claude/settings.json` (com backup em `settings.json.bak-hexlog` antes
   de qualquer troca) e registra o servidor MCP em escopo `user`. A regra de deny
   de um `<D>` antigo que o guard remove é impressa (`removed deny rule: <regra>`),
   e só sai se esse diretório sumiu do disco: um `<D>` antigo que ainda existe
   mantém as regras, porque o deny é o isolamento do dado que ele guarda.
4. Copia cada pasta de `skills/` (hoje `hexlog`, `hexlog-flow` e
   `hexlog-setup`) para `~/.claude/skills/<nome>/`, com troca atômica e sem
   backup, em toda execução, mesmo sem mudança no artefato.

Com dado 0.x em `<D>`, o comando só lista o que arquivaria (`scripts/install.ts#listLegacy`)
e sai com 2, sem instalar nada: veja [Dado 0.x](migracao.md#dado-0x-arquivamento---archive-0x).

**Mudar código no repositório não afeta nenhuma sessão em andamento nem novas
sessões até rodar o instalador de novo.** As sessões sempre executam a cópia
de `~/.local/lib/hexlog/<versão>/`, nunca a working tree. Depois de instalar,
reinicie o Claude Code: a lista de tools é cache da sessão.

A saída do instalador é um resumo: `hexlog <versão>: installed`, `reinstalled`,
`repaired` ou `already installed and intact; nothing to do`, os sha256 do servidor e
do hook, `settings.json: updated` ou `already correct` e, se houver, linhas
`warning: ...`. Os avisos do instalador são `installed artifact modified; repairing`
(o artefato instalado divergia do próprio manifesto) e `version <versão> reinstalled
with different content; consider bumping the version`. Rodar de novo sem nada ter
mudado não reinstala o artefato, não reescreve `settings.json` nem registra o MCP outra
vez; só as skills são recopiadas. Argumento desconhecido é recusado com exit 1 antes
de qualquer escrita; os aceitos são `--check` e `--archive-0x`.

### Instalação concorrente

Se dois processos de instalação rodarem ao mesmo tempo, um deles pode
terminar com a mensagem `another installation swapped <versão> at the same
time; run the installer again`. Nesse caso, espere a outra instalação
terminar e rode `node scripts/install.ts` de novo.

### Versões antigas

O instalador nunca apaga versões antigas de `~/.local/lib/hexlog/`. A remoção
é manual, e só deve ser feita para versões **não registradas** em
`settings.json`/`~/.claude.json`, e **só depois de reiniciar todas as sessões
abertas**: uma sessão iniciada antes da troca de versão mantém o servidor
antigo carregado em memória e pode continuar chamando o caminho antigo do
hook mesmo depois de o diretório ser removido.

## Verificação (`--check`)

```sh
node scripts/install.ts --check
```

Rode isso depois de: reinstalar o harness do Claude Code, trocar de versão do
Node pelo nvm, mexer manualmente em `~/.local/lib/hexlog/`, ou quando uma
instalação avisou `installed artifact modified; repairing` ou `reinstalled with
different content`. O `--check` não arquiva e nem olha `<D>` em busca de dado 0.x.

O `--check` é o único mecanismo que detecta o guard ausente, alterado ou
quebrado. Ele confere, nesta ordem, e cada item pendente aparece como
`missing: <item>`:

| Item | Significa |
|---|---|
| `deny-read-dir` | falta a regra `Read(/<dados>)` em `permissions.deny` |
| `deny-read` | falta a regra `Read(/<dados>/**)` |
| `deny-edit` | falta a regra `Edit(/<dados>/**)` |
| `deny-edit-lib` | falta a regra `Edit(/<home>/.local/lib/hexlog/**)`, que protege o artefato instalado |
| `hook` | não há entrada do hook do hexlog em `hooks.PreToolUse` |
| `hook-matcher` | a entrada do hook existe, mas o `matcher` não é `^Bash$` ou o `type` não é `command`; reinstalar repara os dois no lugar |
| `node` | o executável do Node referenciado no hook não existe |
| `hook-file` | o `bash-guard.mjs` referenciado no hook não existe em disco |
| `hook-not-denying` | o hook instalado não devolveu exit 2 para um comando que deveria negar |
| `hook-not-allowing` | o hook instalado não devolveu exit 0 para um comando inofensivo |
| `mcp` | `~/.claude.json` não tem `mcpServers.hexlog` apontando pro servidor esperado |
| `artifact-modified` | os bytes de `server.mjs` ou `bash-guard.mjs` instalados divergem do `manifest.json` da própria versão |
| `skill-file:<nome>` | falta `~/.claude/skills/<nome>/SKILL.md` de alguma das skills de `skills/` (um item por skill) |

Qualquer item na lista de faltando encerra o `--check` com exit 1.

`artifact-modified` significa que o artefato instalado foi modificado por
fora do instalador (por exemplo, um `cp` ou `node -e` direto no arquivo).
Resolve rodando o instalador de novo: ele detecta a divergência, repara o
artefato e registra isso na saída como `repaired`, com o aviso `installed artifact
modified; repairing`.

Já o aviso `artifact-outdated` só sai no `--check` (o instalador nunca o emite), impresso
como `warning: artifact-outdated: ...`, sem afetar o exit: o build da working tree
produz bundles diferentes dos que o `manifest.json` da versão instalada registra, e a
mensagem cita o commit instalado e o `HEAD` atual. Não quebra o isolamento; é só um
lembrete de que existe um build mais novo disponível. Sem item pendente nem aviso, o
`--check` imprime `ok`.

## Como reverter

1. Restaurar `~/.claude/settings.json.bak-hexlog` sobre `~/.claude/settings.json`,
   ou remover manualmente as 4 regras de deny e a entrada do hook do hexlog
   em `hooks.PreToolUse`.
2. `claude mcp remove hexlog -s user`.
3. `rm -rf ~/.local/lib/hexlog`.
4. `rm -rf ~/.claude/skills/hexlog ~/.claude/skills/hexlog-flow ~/.claude/skills/hexlog-setup`.
   O instalador grava essas skills e nenhum dos passos acima as remove.

Os dados já registrados em `<D>` não são apagados por nenhum desses passos. Para
voltar ao servidor 0.x, veja [Voltar ao 0.x](migracao.md#voltar-ao-0x).
