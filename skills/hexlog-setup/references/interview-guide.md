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

## 4. Gate custom por fase

"Alguma dessas fases tem um critério de 'passou/não passou' que você quer que o
hexlog avalie como gate (ex.: 'a revisão de design está completa')? Se sim, qual
fase e qual o critério?" — vira `register_gate` + a entrada em `gate` no frontmatter.
Fases sem gate custom simplesmente não entram nesse campo.

## 5. Padrão do target (só se o padrão default não servir)

Só pergunte isso se, durante a leitura das skills apontadas (passo 2 do `SKILL.md`),
os targets do projeto não couberem no padrão default (`[^\s:]+`, qualquer coisa sem
espaço ou `:`) — por exemplo, se o projeto usa um formato de id fixo tipo
`PROJ-123`. Nesse caso: "os itens de trabalho deste projeto seguem algum formato de
id fixo (tipo `PROJ-123`)? Se sim, qual?" — vira `targetIdPattern`.

## 6. Opcionais (depois do plano aprovado e registrado)

Depois do passo 6 do `SKILL.md` (ponteiro no `AGENTS.md`), uma pergunta por
opcional, nesta ordem:

1. "Quer que eu edite as skills que você apontou para chamarem a `hexlog-flow`
   automaticamente nos pontos de decisão? Eu mostro o diff de cada uma, uma por
   vez, antes de gravar." — só prossiga para o diff da próxima skill depois da
   aprovação da anterior.
2. "Quer ativar um hook que lembra de registrar no hexlog toda vez que uma dessas
   skills for chamada? Ele só lembra, nunca bloqueia."
