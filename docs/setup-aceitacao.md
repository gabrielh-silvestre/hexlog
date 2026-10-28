# Aceite do setup

Roteiro manual para provar que a skill `hexlog-setup` prepara um repositório de destino e que o
ciclo de uma unidade chega ao gate verde. O jest prova a forma dos exemplos, o gate e as varreduras dos textos; o comportamento do
agente (entrevista, descoberta, adesão à skill gerada) só este roteiro prova. A evidência fica no
hexlog, anexada ao processo do trabalho que roda o aceite.

## Pré-condições

- O hexlog está instalado a partir de um checkout (`npm ci`, depois `node scripts/install.ts`), e
  `node scripts/install.ts --check` sai verde. Ver [instalacao.md](instalacao.md).
- `list` sem parâmetros responde no Claude Code do aceite.
- Escolha um **nome de projeto hexlog descartável**, como `setup-acceptance-<aaaammdd>-<n>`, e
  confira por `list` que ele **não existe** antes de começar. Escolha um segundo nome descartável
  para o diretório sem fluxo reconhecível.
- Nenhuma execução do aceite usa o projeto `hexlog` nem outro projeto real: o armazenamento é
  append-only e não há como remover uma definição.
- Um repositório temporário vazio, fora do diretório pessoal, com `git init`.
- Para rodar com um `HOME` temporário, exporte `HOME` apontando para um diretório descartável antes
  de instalar e de abrir o Claude Code: assim o `~/.claude` real não é tocado. O `<D>` segue o
  `XDG_DATA_HOME`, então aponte-o também para um diretório descartável se não quiser projetos novos
  no `<D>` real.

## Aprovações do dono

Cada ação abaixo é pedida ao dono no momento em que for executada.

- **Instalar as skills da branch** (exige aprovação do dono): `node scripts/install.ts` escreve em
  `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/`. Depois, `diff -r` de
  cada uma das três pastas (`skills/hexlog`, `skills/hexlog-flow` e `skills/hexlog-setup`) contra
  `~/.claude/skills/<nome>` prova que a instalação está atualizada, porque a verificação do
  instalador só confere a presença do `SKILL.md`.
- **Projetos descartáveis ficam permanentes**: cada execução cria um projeto hexlog em `<D>`. Os
  projetos descartáveis permanecem em `<D>`. Se o dono quiser limpar, o ponto de partida é o
  procedimento manual de [dados.md](dados.md) (seção "Recuperar um processo corrompido"), adaptado
  ao diretório do projeto, num terminal fora do Claude Code e por decisão dele.

## Repositório de teste

O fluxo de teste é neutro, de três fases por unidade: `design`, `build` e `check`. Cada unidade é uma
pasta `docs/features/<nome>/` e cada fase deixa um artefato nela (`design.md`, `build.md`,
`check.md`). No repositório temporário, crie os três comandos e faça o commit-base:

```sh
mkdir -p .claude/commands docs/features
for fase in design build check; do
  printf 'Fase %s da feature $ARGUMENTS: escreva docs/features/$ARGUMENTS/%s.md com um parágrafo.\n' \
    "$fase" "$fase" > ".claude/commands/$fase.md"
done
printf '# Fluxo\n\nCada feature passa por /design, /build e /check, nessa ordem.\n' > README.md
git add -A && git commit -m "chore: base flow"
```

Os comandos são `/design <nome>`, `/build <nome>` e `/check <nome>`. Os artefatos podem também ser
criados à mão, se o dono preferir não rodar os comandos.

## Passo a passo

1. No repositório de teste, faça o commit-base descrito acima.
2. Abra o Claude Code nesse diretório e peça "configura o hexlog nesse repositório". Escolha a
   **descoberta**. Responda à entrevista com o nome descartável do primeiro projeto.
3. Faça o commit depois do setup. A janela do `git diff` de `CLAUDE.md` e de `AGENTS.md` vai do
   commit-base a este commit, **antes** do ciclo das fases.
4. Rode o ciclo `/design`, `/build` e `/check` numa unidade de exemplo, sem lembrar o agente de
   registrar. Confira que há um registro por fase no processo da unidade e que o gate passa. Confira
   também que o agente fechou a unidade sozinho (consultou um registro por fase ao fim de `/check`) e
   que a skill do projeto e o bloco do `AGENTS.md` foram aplicados na sessão sem pedido seu.
   Repita o ciclo em mais duas unidades novas, cada uma em sessão nova (três unidades no total), e
   anote, por unidade, quantas das três fases o agente registrou sem lembrete.
5. Rode o setup de novo no mesmo diretório. Confira que não houve entrevista, nem registro duplicado,
   nem diferença no `git diff`.
6. Apague o bloco do `AGENTS.md` e rode o setup de novo: o bloco volta.
7. Apague a pasta da skill do projeto e rode de novo. Confira por `list` o projeto antes e depois: a
   recuperação guiada confirma o projeto, refaz só unidade, fases e comandos e **não cria versão nova**.
8. Em outro diretório novo, rode o setup com o nome de um projeto que já existe (o descartável da
   primeira execução): o setup tem de parar e mostrar as definições vigentes.
9. Em um diretório vazio, sem fluxo reconhecível, e com o segundo nome descartável, escolha a
   **entrevista direta**: os mesmos artefatos têm de sair.
10. Repositórios que ainda têm o mapa antigo: confira só que o setup não cria nenhum arquivo de mapa
    em `.hexlog/` do destino (rode o setup num diretório de teste que tenha o arquivo do mapa antigo
    em `.hexlog/` e confira que ele continua como estava).

O clone do destino, com o modelo, para um `<D>` sem o projeto não é testado neste roteiro; a
cobertura é só pela instrução do `SKILL.md`.

## Checklist

Marque cada item com a evidência (saída do comando, trecho do `git diff` ou o id do registro).

### Geração dos artefatos

- [ ] O setup por descoberta, no repositório de teste, gera a skill do projeto em inglês e o
  `hexlog-model.json` sem edição de arquivo à mão.
- [ ] A entrevista direta, no diretório sem fluxo reconhecível, gera os mesmos artefatos.
- [ ] O `.claude/settings.json` do destino não ganhou hook.
- [ ] O `git diff` de `CLAUDE.md` está vazio sem opt-in do dev.

### Bloco do `AGENTS.md`

- [ ] O bloco no `AGENTS.md` tem até 8 linhas.
- [ ] A skill do projeto e o bloco são carregados na sessão do destino.
- [ ] Sem `CLAUDE.md` com o import `@AGENTS.md`, o bloco fica inerte e isso foi anotado; com o import,
  ele é alcançado.

### Ciclo da unidade

- [ ] O ciclo `/design`, `/build` e `/check` registra um registro por fase no processo da unidade,
  ligados por relação, e o gate passa.
- [ ] Três unidades completas foram feitas e a adesão foi anotada, sem lembrete humano.
- [ ] O fechamento da unidade confere o gate sem lembrete humano.

### Reaplicação e projeto existente

- [ ] Reaplicar não faz entrevista, não duplica registro e deixa o `git diff` vazio.
- [ ] O bloco do `AGENTS.md` ausente é restaurado.
- [ ] Sem a pasta da skill do projeto, a recuperação guiada não cria versão nova (`list` antes e
  depois).
- [ ] O setup confere o projeto por `list` antes da primeira chamada `define_*` e, com projeto já
  existente, para e mostra as definições vigentes.
- [ ] Com o arquivo do mapa antigo em `.hexlog/` no destino, o setup o deixa como estava e não cria
  nenhum arquivo de mapa.

## Anexar a evidência

No processo do trabalho que rodou o aceite:

1. Junte o relatório do roteiro em um texto e guarde com `attach` (parâmetro `text`).
2. Registre uma `evidence` com `summary` e `source`, no target `<trabalho>.evidence.setup-acceptance`,
   apontando para o anexo e ligada por `supports` às decisões que o aceite sustenta.
3. Confira com `query` por `type: evidence` e `targetPrefix` `<trabalho>.evidence.setup-acceptance`.

## Reverter a instalação da branch

Siga [instalacao.md](instalacao.md), seção "Como reverter", e rode o `--check` para confirmar. Mantenha
a instalação da branch só a pedido do dono.
