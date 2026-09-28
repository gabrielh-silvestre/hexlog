# Piloto: OMC do fork com hexlog (só neste repositório)

Neste repositório, o `oh-my-claudecode@omc` (upstream) fica desligado e o
`oh-my-claudecode@omc-hexlog` fica ligado. O `omc-hexlog` é o fork
[gabrielh-silvestre/oh-my-claudecode](https://github.com/gabrielh-silvestre/oh-my-claudecode),
na branch `hexlog`, que parte de `v4.15.10`, a mesma versão do upstream
instalada no início do piloto. Os outros projetos continuam no upstream.

- Marketplace e plugin: `.claude/settings.json` (escopo de projeto)
- Clone local do fork: `~/personal/oh-my-claudecode`, com o remote
  `upstream` apontando para `Yeachan-Heo/oh-my-claudecode`

## Estado

O `/hexlog-setup` já rodou: `.hexlog/flow.md` mapeia 4 fases (processos
`omc-discover`, `omc-plan`, `omc-exec`, `omc-verify`) e 8 skills do fork, que
chamam a `hexlog-flow` nos pontos de decisão (commit `6a67a7d60`).

## Aplicar uma mudança no fork

O `plugin update` só troca o cache quando a versão muda. Sem o bump, ele
responde "already at the latest version" e o Claude Code continua com o
conteúdo antigo.

```sh
cd ~/personal/oh-my-claudecode   # editar na branch hexlog
# subir o sufixo -hexlog.N em .claude-plugin/plugin.json e no plugin de
# .claude-plugin/marketplace.json; commitar
git push
claude plugin marketplace update omc-hexlog
claude plugin update oh-my-claudecode@omc-hexlog --scope project
# reiniciar o Claude Code
```

## Acompanhar o upstream

```sh
cd ~/personal/oh-my-claudecode
git fetch upstream --tags
git rebase <nova-tag> hexlog && git push --force-with-lease
# o rebase conflita no version: ficar com <nova-tag>-hexlog.1
```

## Reverter o piloto

1. Em `.claude/settings.json`, remover `oh-my-claudecode@omc`,
   `oh-my-claudecode@omc-hexlog` e o bloco `extraKnownMarketplaces.omc-hexlog`.
2. Rodar `claude plugin uninstall oh-my-claudecode@omc-hexlog --scope project`
   e `claude plugin marketplace remove omc-hexlog`.
3. Apagar o `.hexlog/flow.md` se quiser rodar o `/hexlog-setup` de novo contra
   o upstream.
4. Opcional: apagar o fork no GitHub e o clone local.

A reversão não desfaz os eventos já registrados no hexlog, porque o log é
append-only.
