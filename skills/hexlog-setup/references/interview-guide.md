# Roteiro da entrevista

Uma pergunta por turno, esperando a resposta antes da próxima. As perguntas abaixo são um roteiro-modelo: adapte a redação ao que o dev já disse e mantenha a ordem. **As perguntas saem em inglês** (a saída do setup é em inglês); este arquivo é pt-BR por convenção do repositório.

Dois caminhos, escolhidos no início. Os dois terminam nas mesmas perguntas de unidade, fases e registros; a descoberta embasa as respostas com o que o repositório mostra.

## 0. Caminho

"Do you want me to discover how this project works by reading the repository first (read-only), or should I just interview you?"

- **Descoberta**: leia em modo leitura e deduza a ferramenta de orquestração do que o repositório mostra. Resuma ao dev o que achou (pastas de specs, comandos de fase, convenções de nome) e use o resumo para propor respostas às perguntas 3 a 6, que o dev confirma ou corrige.
- **Entrevista direta**: faça as perguntas 3 a 6 sem proposta prévia.

## 1. Nome do projeto hexlog

"What should the hexlog project be called? Use `[a-z0-9-]`, start with a letter or a digit, up to 63 characters." Confira por `list` antes de qualquer `define_*`.

## 2. Projeto já existente

Quando o `list` mostra o projeto e o setup está sem modelo local (passo 2 do `SKILL.md`): "That hexlog project already exists. Here are its current definitions. Do you want to continue and add to it? Definitions are append-only and permanent." Pare até a confirmação explícita.

## 3. Unidade de trabalho

"What is one unit of work in this project (for example a feature folder, a ticket, a change request), and where does it live in the repository?" Vira `unit.kind` e `unit.location`. Peça um exemplo real para `unit.examples`.

## 4. Fases

"Which phases does a unit go through, in order?" Uma fase vira um tipo de registro. Depois, uma fase por turno: "What command or action starts the {phase} phase, and what file or artifact does it produce?" Vira `command` e `artifact`.

## 5. O que se registra em cada fase

Uma pergunta por fase: "In the {phase} phase, what should be recorded? Which fields, and is any of them a long text (a report, a plan, a spec) that would go as an attachment?" Campo de hash de anexo e o campo `unit` seguem `model-schema.md`; avise o dev na hora de que marcar o anexo depois exige versão nova com `breaking: true` (seção "Conferência de anexo" do `SKILL.md`).

Se o registro de uma fase se liga ao de outra (deriva, aprova, substitui), pergunte o sentido da ligação: "How does a {phase} record relate to the {previous phase} record?" Vira uma relação (`links`).

## 6. Gate

"What makes a unit complete? For example: every phase has a record and each phase record is linked to the previous one." Vira o gate (cobertura e encadeamento, em `model-schema.md`). Se a evidência vem de registro de outra fase, a pergunta declara `scope: "project"`.

## 7. Padrão do target

Pergunte quando os rótulos do projeto ficam fora da sintaxe padrão (segmentos minúsculos com hífen): "Do the work items follow a fixed label format (like `proj-123`)? If so, which one?" Vira `targetPattern` no modelo.

## 8. Ponteiro no destino

"Does your `CLAUDE.md` already import `AGENTS.md`? If not, may I add the import at the end of the file, outside any region managed by another tool?" O arquivo muda só com resposta afirmativa.
