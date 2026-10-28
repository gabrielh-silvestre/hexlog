# Aceite do setup

Roteiro manual para provar que a skill `hexlog-setup` leva um repositório de destino do zero ao
gate verde. O jest prova a forma dos exemplos, o gate e as varreduras dos textos; o comportamento do
agente (entrevista, descoberta, adesão à skill gerada) só este roteiro prova. A evidência fica no
hexlog, anexada ao processo do trabalho que roda o aceite.

## Pré-condições

- O hexlog está instalado a partir de um checkout (`npm ci`, depois `node scripts/install.ts`), e
  `node scripts/install.ts --check` sai verde. Ver [instalacao.md](instalacao.md).
- `list` sem parâmetros responde no Claude Code do aceite.
- Escolha um **nome de projeto hexlog descartável**, como `setup-acceptance-<aaaammdd>-<n>`, e
  confira por `list` que ele **não existe** antes de começar. Escolha um segundo nome descartável
  para o diretório sem Spec Kit.
- Nenhuma execução do aceite usa o projeto `hexlog` nem outro projeto real: o armazenamento é
  append-only e não há como remover uma definição.
- Um repositório temporário vazio, fora do diretório pessoal, com `git init`.

## Aprovações do dono

Cada ação abaixo é pedida ao dono no momento em que for executada.

- **Instalar as skills da branch** (exige aprovação do dono): `node scripts/install.ts` escreve em
  `~/.claude/settings.json`, `~/.claude.json` e `~/.local/lib/hexlog/`. Depois, `diff -r` de
  `skills/hexlog-setup` contra `~/.claude/skills/hexlog-setup` prova que a instalação está
  atualizada, porque a verificação do instalador só confere a presença do `SKILL.md`.
- **Baixar o Spec Kit** (exige aprovação do dono): `specify init` na versão 1.2.4, num diretório
  temporário, baixa e executa código de terceiros. O comando exato vem da documentação oficial
  **durante o aceite** e é colado neste roteiro antes de qualquer marcador de pré-PR.
- **Projetos descartáveis ficam permanentes**: cada execução cria um projeto hexlog em `<D>`. Se o
  dono quiser limpar, o caminho é o procedimento manual de quarentena de [dados.md](dados.md), num
  terminal fora do Claude Code, por decisão dele.

## Passo a passo

1. Em um diretório temporário, rode `specify init` (exige aprovação do dono) e faça o commit-base.
2. Abra o Claude Code nesse diretório e peça "configura o hexlog nesse repositório". Escolha a
   **descoberta**. Responda à entrevista com o nome descartável do primeiro projeto.
3. Faça o commit depois do setup. A janela do `git diff` de `CLAUDE.md` e de `AGENTS.md` vai do
   commit-base a este commit, **antes** do ciclo `specify`, `plan` e `tasks`: o próprio Spec Kit pode
   reescrever esses arquivos no ciclo, e o que ele escrever é anotado, não imputado ao setup.
4. Rode o ciclo `specify`, `plan` e `tasks` numa unidade de exemplo, sem lembrar o agente de registrar.
   Confira que há um registro por fase no processo da unidade e que o gate passa.
5. Rode o setup de novo no mesmo diretório. Confira que não houve entrevista, nem registro duplicado,
   nem diferença no `git diff`.
6. Apague o bloco da camada C do `AGENTS.md` e rode o setup de novo: o bloco volta.
7. Apague a pasta da skill do projeto e rode de novo. Confira por `list` o projeto antes e depois: a
   recuperação guiada confirma o projeto, refaz só unidade, fases e comandos e **não cria versão nova**.
8. Em outro diretório novo, rode o setup com o nome de um projeto que já existe (o descartável da
   primeira execução): o setup tem de parar e mostrar as definições vigentes.
9. Em um diretório vazio, sem Spec Kit, e com o segundo nome descartável, escolha a **entrevista
   direta**: os mesmos artefatos têm de sair.
10. Repositórios que ainda têm o mapa antigo: confira só que o setup não cria nenhum arquivo de mapa
    em `.hexlog/` do destino.

O clone do destino, com o modelo, para um `<D>` sem o projeto não é testado neste roteiro; a
cobertura é só pela instrução do `SKILL.md`.

## Checklist

Marque cada item com a evidência (saída do comando, trecho do `git diff` ou o id do registro).

### Geração dos artefatos

- [ ] O setup por descoberta, no diretório com Spec Kit, gera a skill do projeto em inglês e o
  `hexlog-model.json` sem edição de arquivo à mão.
- [ ] A entrevista direta, no diretório sem fluxo reconhecível, gera os mesmos artefatos.
- [ ] O que o `specify init` gerou foi anotado (layout observado, `CLAUDE.md`, `AGENTS.md` e regiões
  gerenciadas).
- [ ] O `.claude/settings.json` do destino não ganhou hook.
- [ ] O `git diff` de `.claude/skills/speckit-*` e o de `CLAUDE.md` estão vazios sem opt-in do dev.

### Camada C

- [ ] A camada C é sempre gerada e o setup imprime a camada ativa.
- [ ] O bloco da camada C no `AGENTS.md` tem até 8 linhas.
- [ ] A skill do projeto e o bloco são carregados na sessão do destino.
- [ ] A camada B continua desativada: a tabela de versões provadas está sem linhas.

### Ciclo da unidade

- [ ] O ciclo `specify`, `plan` e `tasks` registra um registro por fase no processo da unidade,
  ligados por relação, e o gate passa.
- [ ] Três rodadas completas só com a camada C foram feitas e a adesão foi anotada (linha de base).
- [ ] O fechamento da unidade confere o gate sem lembrete humano.

### Reaplicação e projeto existente

- [ ] Reaplicar não faz entrevista, não duplica registro e deixa o `git diff` vazio.
- [ ] O bloco da camada C ausente é restaurado.
- [ ] Sem a pasta da skill do projeto, a recuperação guiada não cria versão nova (`list` antes e
  depois).
- [ ] O setup confere o projeto por `list` antes da primeira chamada `define_*` e, com projeto já
  existente, para e mostra as definições vigentes.

## Anexar a evidência

No processo do trabalho que rodou o aceite:

1. Junte o relatório do roteiro em um texto e guarde com `attach` (parâmetro `text`).
2. Registre uma `evidence` com `summary` e `source`, no target `<trabalho>.evidence.setup-acceptance`,
   apontando para o anexo e ligada por `supports` às decisões que o aceite sustenta.
3. Confira com `query` por `type: evidence` e `targetPrefix` `<trabalho>.evidence.setup-acceptance`.

## Reverter a instalação da branch

Siga [instalacao.md](instalacao.md), seção "Como reverter", e rode o `--check` para confirmar. Mantenha
a instalação da branch só a pedido do dono.
