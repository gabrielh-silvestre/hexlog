# Roteiro da entrevista

Uma pergunta por turno, esperando a resposta antes da próxima — nunca despejar o
roteiro inteiro nem agrupar duas decisões no mesmo turno. As perguntas abaixo são
um roteiro-modelo, não um formulário fixo: adapte a redação ao que o usuário já
disse, mas mantenha a ordem — cada pergunta depende da resposta da anterior.

## 1. Fases

"Quais são as fases do fluxo pré-código deste projeto (antes do código virar
código)? Por exemplo: discovery, planejamento, revisão de design, revisão de
tasks." Espere a lista antes de seguir — vira o campo `phases`.

## 2. Skills/tools por fase

Para cada fase levantada em (1), uma pergunta separada: "Na fase de {fase}, quais
skills, comandos ou ferramentas você usa hoje?" Não pergunte por todas as fases de
uma vez — uma fase por turno.

## 3. Processo por fase

"Cada fase vira um processo separado no hexlog (`create_process`), ou algumas
fases compartilham o mesmo processo?" — lembrando que o mapeamento é 1:1 (uma fase,
um processo cada), então a resposta aqui só decide os *nomes*, não se o
mapeamento existe.

## 4. O que se registra em cada ponto de decisão

Depois de ler as skills apontadas (passo 2 do `SKILL.md`), uma pergunta por ponto de
decisão extraído: "Neste ponto, o que o agente registra — que campos o registro
precisa ter, e algum deles guarda um texto longo (relatório, plano, spec) que iria
como anexo?" — vira um `define_type`. Todo campo que guarda hash de anexo recebe
`format: "attachment"`: avise, na hora, que marcar o campo depois exige uma versão
nova do tipo com `breaking: true`. Se o registro se liga a outro (aprova, contradiz,
substitui, responde), pergunte qual é o sentido da ligação — vira a relação
(`kind`) e, se tiver sentido próprio, um `define_relation` com as pontas.

## 5. Gate por fase

"Alguma dessas fases tem um critério de 'passou/não passou' que você quer que o
hexlog avalie como gate (ex.: 'a revisão de design está completa')? Se sim, qual
fase e que registros provam o critério?" — vira um `define_gate` (perguntas sobre os
tipos da etapa anterior) e a entrada em `gate` no frontmatter. Se a evidência vem de
registro de outra fase, a pergunta declara `scope: "project"`. Fases sem gate
simplesmente não entram nesse campo.

## 6. Padrão do target (só se a sintaxe default não servir)

Só pergunte isso se, durante a leitura das skills apontadas (passo 2 do `SKILL.md`),
os targets do projeto não couberem na sintaxe default (rótulo `a.b.c`, segmentos
minúsculos com hífen) ou precisarem de um formato fixo — por exemplo, se o projeto
numera tarefas como `proj-123`. Nesse caso: "os itens de trabalho deste projeto
seguem algum formato fixo de rótulo (tipo `proj-123`)? Se sim, qual?" — vira
`targetIdPattern`.

## 7. Opcional (depois do plano aprovado e registrado)

Depois do passo 6 do `SKILL.md` (ponteiro no `AGENTS.md`):

"Quer que eu edite as skills que você apontou para chamarem a `hexlog-flow`
automaticamente nos pontos de decisão? Eu mostro o diff de cada uma, uma por
vez, antes de gravar." — só prossiga para o diff da próxima skill depois da
aprovação da anterior.
