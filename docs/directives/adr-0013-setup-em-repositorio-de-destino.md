# ADR 0013: Setup do hexlog em repositório de destino

**Status:** Aceito

**Data:** 2026-10-28

**Deciders:** Gabriel Baldino (aprovação do plano e do aceite)

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
7. **Sem hooks do Claude Code e com uma exceção deliberada em arquivo de terceiros.** O setup não instala hooks no destino e só escreve a skill do projeto e o modelo; a exceção é o bloco da camada C no `AGENTS.md` do destino, criado se faltar e escrito fora de região gerenciada. O import no `CLAUDE.md` exige opt-in do dev e vai no fim do arquivo.
8. **Saída em inglês.** O que o setup diz ao dev e grava no destino sai em inglês; o corpo das skills do produto segue pt-BR.

## Drivers

Premissas de [estrategia.md](estrategia.md): `nucleo-sem-termo-de-fluxo`, `ferramentas-fixas`, `definicao-fixada-por-processo` e `libs-em-faixa-caret`. Mais três critérios desta decisão: nada de arquivo de terceiros alterado por padrão, a menos da exceção do item 7; incerteza alta sobre o disparo de hooks do Spec Kit, que mantém B e A atrás de prova ou consentimento; e testabilidade do que for determinístico, deixando só o comportamento do agente para o roteiro de aceite.

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

É a menor mudança que cumpre o objetivo sem tocar o servidor nem o instalador. A camada C é segura e autossuficiente: escreve a skill do projeto, o modelo e um bloco delimitado no `AGENTS.md` do destino, e a adesão foi medida no aceite. B e A entram com prova ou consentimento. O JSON é validável em jest, e a mecânica versionada chega a todos os destinos pela reinstalação.

## Consequences

- Repositórios com o mapa antigo perdem o guia da `hexlog-flow` até rodar o setup (Migração no changelog; migrar é outra frente).
- A tabela de versões provadas do Spec Kit exige manutenção manual.
- A adesão do LLM e a entrevista só se provam pelo roteiro de aceite.
- Unidades abertas ficam presas às definições com que nasceram.
- O ADR 0005 fica substituído quanto ao mapa por repositório.

## Follow-ups

Sonda e camadas B e A (segundo PR, com emenda datada); script automatizado de aceite; instalação sem checkout; hooks do Claude Code no destino; kit portátil de diretrizes, premissa e lacuna; validador de `hexlog-model.json` como script de leitura.

## Emenda 2026-10-28

Emenda datada aos achados da review do PR #321, aplicada por decisão do dono, Gabriel Baldino. Decision e Consequences acima não mudam.

- **Limite aceito do item 3.** Resolver a unidade por `query` com `scope: "project"` herda o `PROCESS_CORRUPTED` do alcance projeto (ver a seção `query` de [tools.md](../tools.md)): uma cadeia quebrada em qualquer processo do projeto falha a consulta em todas as outras unidades, e o custo cresce com o número de unidades. O limite é aceito. Alternativa não adotada: calcular o nome, consultar com `process` e `where` por `unit`, e usar `scope: "project"` só na colisão.
- **Evidência do aceite.** "Medido" e "observado no aceite" (Context, Why chosen) apoiam-se nas `evidence` do processo `feat-hexlog-setup-new-project`, registradas no hexlog do dono: `evidence.setup-acceptance` e `evidence.setup-acceptance-after-review`. Elas vivem no log, não em arquivo versionado.
- **Correção do Context sobre `specify integration upgrade`.** A documentação oficial (`docs/integrations/cli.md` do Spec Kit, versão 1.2.4) diz que o upgrade bloqueia quando há arquivo gerado modificado e que `--force` sobrescreve; a preservação por padrão é do `uninstall` e do `switch`. A alternativa 2 segue rejeitada, porque o `--force` desfaz a camada A nos dois casos.
- **Leitura do `AGENTS.md` pelo Claude Code.** Sem `CLAUDE.md`, o Claude Code lê o `AGENTS.md` direto (v2.1.277 ou mais nova). O que deixa o bloco da camada C inerte é um `CLAUDE.md` sem o import `@AGENTS.md`, ou um Claude Code mais antigo. A adesão medida no aceite foi com o import presente, não no caminho padrão sem opt-in. O item 7 vale como está.
- **Exceção do item 7 mantida.** O dono manteve, em 2026-10-28, a escrita do bloco no `AGENTS.md` sem opt-in. A premissa que registra essa exceção substitui `no-third-party-edit`.

## Emenda 2026-10-28 (Spec Kit fora do produto)

Emenda datada, aplicada por decisão do dono, Gabriel Baldino. Decision e Consequences acima não mudam, e a emenda anterior segue vigente no que não conflita com esta.

- **O Spec Kit não faz parte do produto.** Foi só o harness que testou o fluxo novo do setup. Saem do escopo o plug no Spec Kit, as camadas C, B e A, a tabela de versões provadas, a sonda e o segundo PR citado em Follow-ups.
- **O histórico acima fica, e esta emenda o supera.** As menções ao Spec Kit e à camada C no Context, nas Decisions (item 6), nos Drivers, nas Alternatives considered, no Why chosen, nas Consequences e na emenda anterior ficam como histórico. Quando uma delas conflitar com esta emenda, vale esta.
- **O bloco do `AGENTS.md` do destino continua.** O item 7 vale como está: o setup escreve a skill do projeto, o modelo e um bloco de até 8 linhas no `AGENTS.md` do destino, agora sem o nome de camada. O roteiro de aceite usa um fluxo neutro de três fases (`design`, `build` e `check`).
- **A entrega sai em um PR.**
