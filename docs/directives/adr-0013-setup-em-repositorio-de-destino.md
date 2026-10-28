# ADR 0013: Setup do hexlog em repositório de destino

**Status:** Proposto

**Data:** 2026-10-28

**Deciders:** Gabriel Baldino (aprovação do plano e do aceite), com o plano de consenso entre planner, architect e critic

---

## Context

O `hexlog-setup` da era 0.x (ADR 0005, só no git: `git show 8fcfa34^:docs/adr-0005-hexlog-setup-hexlog-flow.md`) gravava um mapa por repositório e podia editar skills globais. Cada repositório de destino tem um fluxo diferente, e o vínculo entre o fluxo e o hexlog por uma frase de texto é frágil. Nenhum ADR vigente trata do setup, então a mudança vai num ADR novo, sem emenda a ADR aceito ([adr-0010-camada-sobre-omc.md](adr-0010-camada-sobre-omc.md) cobre só a camada sobre o OMC neste repositório).

O Spec Kit é o primeiro fluxo externo atendido. Segundo a documentação oficial consultada na data deste ADR (versão 1.2.4) e o layout observado no aceite:

- `specify init <projeto> --integration claude` cria as skills dos comandos em `.claude/skills/speckit-<comando>/SKILL.md` (invocadas como `/speckit-specify`, `/speckit-plan` e `/speckit-tasks`) e a pasta `.specify/`; **não** cria `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json` nem repositório git;
- os hooks `before_` e `after_` de um comando ficam em `.specify/extensions.yml`, texto que o próprio LLM executa;
- `specify integration upgrade` usa manifesto e preserva por padrão os arquivos gerados que o dev modificou, e `--force` remove a diferença.

Restrições que moldam a decisão:

- O servidor e o instalador não mudam (`ferramentas-fixas`, `nucleo-sem-termo-de-fluxo`): o fluxo mora em skills, docs e testes.
- A definição é fixada por processo (`definicao-fixada-por-processo`): unidades abertas ficam presas às definições com que nasceram.
- O armazenamento é append-only: definição gravada no projeto errado é permanente.

## Decision

1. **Skill do projeto e modelo declarativo.** O `hexlog-setup` aprende o fluxo do repositório de destino, por descoberta no repositório ou por entrevista (o dev escolhe), e gera ali uma **skill do projeto** fina e um **modelo declarativo em JSON** (`hexlog-model.json`) ao lado dela. O mapa antigo e a edição de skills deixam de existir.
2. **Mecânica na `hexlog-flow`.** A `hexlog-flow` passa a ser a skill de mecânica das tools e guarda o ciclo de vida da unidade de trabalho em `references/unit-lifecycle.md`; a skill gerada só carrega dados (tabela de fases) e ponteiros.
3. **Um processo por unidade.** A skill gerada cria o processo na primeira fase da unidade; o setup registra só tipos, relações e gate. O caminho canônico da unidade vai em todo registro (campo `unit`) e o processo é resolvido por ele.
4. **Gate de cobertura e encadeamento.** O gate proposto tem um `occurred` por tipo de fase e um `no_pending` por fase com sucessora, resolvido por `derivesFrom`.
5. **Projeto hexlog conferido antes de definir.** O setup pergunta o nome do projeto e confere por `list` antes de qualquer `define_*`; projeto existente sem modelo local para e mostra as definições vigentes.
6. **Plug no Spec Kit em camadas.** **C** sempre: skill do projeto mais um bloco de até 8 linhas no `AGENTS.md`, com o processo resolvido pelo diretório da unidade, nunca por `.specify/feature.json`. **B** (extension ou preset com hooks) só em versão provada por uma sonda que o dono roda. **A** (edição das skills do Spec Kit) só por opt-in com aviso.
7. **Sem hooks do Claude Code e sem terceiros.** O setup não instala hooks no destino e não altera arquivo de terceiros por padrão; o import no `CLAUDE.md` exige opt-in do dev e vai no fim do arquivo, fora de região gerenciada.
8. **Saída em inglês.** O que o setup diz ao dev e grava no destino sai em inglês; o corpo das skills do produto segue pt-BR.

## Drivers

Premissas de [estrategia.md](estrategia.md): `nucleo-sem-termo-de-fluxo`, `ferramentas-fixas`, `definicao-fixada-por-processo` e `libs-em-faixa-caret`; a premissa da entrega "nada de terceiros alterado por padrão"; a confiança baixa do júri no plug; a testabilidade do que for determinístico.

## Alternatives considered

1. Manter o mapa por repositório: rejeitado, o fluxo muda por repositório e o vínculo é frágil.
2. Camada A como padrão: rejeitada, `integration upgrade --force` e `init --here --force` a desfazem.
3. Hooks do Claude Code no destino: fora do escopo, só instruções.
4. YAML ou JSONC para o modelo: rejeitados (dependência nova; comentário em arquivo regenerado).
5. Sonda embutida no setup: rejeitada, executaria terceiros em todo destino sem pedido do dono.
6. Um processo por fase: rejeitado, o fluxo real é por unidade.
7. Compatibilidade de leitura do mapa antigo: rejeitada, dois caminhos.
8. Mecânica da unidade dentro da skill gerada: rejeitada, congela a mecânica de cada destino.

## Why chosen

É a menor mudança que cumpre o objetivo sem tocar o servidor nem o instalador. A camada C é segura e autossuficiente: só escreve arquivos do próprio hexlog e a adesão foi medida no aceite. B e A entram com prova ou consentimento. O JSON é validável em jest, e a mecânica versionada chega a todos os destinos pela reinstalação.

## Consequences

- Repositórios com o mapa antigo perdem o guia da `hexlog-flow` até rodar o setup (Migração no changelog; migrar é outra frente).
- A tabela de versões provadas do Spec Kit exige manutenção manual.
- A adesão do LLM e a entrevista só se provam pelo roteiro de aceite.
- Unidades abertas ficam presas às definições com que nasceram.
- O ADR 0005 fica substituído quanto ao mapa por repositório.

## Follow-ups

Sonda e camadas B e A (segundo PR, com emenda datada); script automatizado de aceite; instalação sem checkout; hooks do Claude Code no destino; kit portátil de diretrizes, premissa e lacuna; validador de `hexlog-model.json` como script de leitura.
