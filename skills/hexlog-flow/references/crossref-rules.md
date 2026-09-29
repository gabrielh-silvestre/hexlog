# Regras de cruzamento (v1)

Três regras, decididas no grilling do mapa de fluxo. Nenhuma delas precisa de tool
nova — todas são combinações de `register`, `evaluate_gate`, `events`, `chain` e
`state` (mais `timeline`, para ler vários processos de uma vez) guiadas pela
leitura do `.hexlog/flow.md`.

## 1. Mesma fase — conflito ou superado

Dois marcos/vereditos registrados na mesma fase (mesmo `process`, já que fase e
processo são 1:1) podem entrar em conflito: uma decisão nova invalida ou refina
uma anterior sobre o mesmo alvo. Registre o novo Veredito com `supersedes`
apontando para o(s) id(s) que ele substitui. Para seguir essa cadeia depois, use
`events` (mesmo `process`) ou `timeline` (todos os processos do projeto, com
`supersededBy` em cada entrada); `chain` só verifica hash e anexos, não segue
`supersedes`. `state` (com `withData: true`) já devolve só o vigente de cada
target, sem precisar reconstruir a cadeia manualmente.

Se dois sucessores vivos citarem o mesmo Veredito superado em `supersedes` (um
fork), o gate embutido `no-forks` reprova. Resolver o fork é registrar mais um
Veredito que supere um dos dois ramos, até restar 1 sucessor vivo — não dá pra
"cancelar" um Veredito já gravado, o log é append-only.

## 2. Entre fases — N chamadas que exigem o `process` certo

Cruzar informação entre fases diferentes não é uma tool especial: é várias
chamadas de leitura (`events`, `chain`, `state`), cada uma com o `process` da
fase que se quer consultar — nunca o `process` da fase corrente por padrão. O
flow map (`process` no frontmatter) é o que traduz "fase X" pro nome de processo
que essas tools esperam.

Exemplo: a fase de revisão quer saber se a fase de planejamento já decidiu algo
sobre um target. Chame `state({project, process: <processo da fase de
planejamento>})` (ou `events`/`chain` com o mesmo `process`), não o processo da
fase de revisão. Para o histórico de um target em todas as fases de uma vez,
`timeline` já cruza os processos do projeto.

## 3. Lacunas — gate custom por fase

Uma lacuna é um critério que o processo não prova sozinho (os 5 gates embutidos
passam trivialmente sem contraevidência — ver `AGENTS.md`/README do hexlog). Se
uma fase do flow map declara um gate custom (`gate` no frontmatter), essa é a
forma combinada de fechar a lacuna: registre esse gate via `register_gate` (feito
pela `hexlog-setup`, não por esta skill) e avalie com `evaluate_gate` informando o nome
em `name` e `result: {passed, evidence}` — a evidência é o que prova que o critério foi
cumprido (ex.: um trecho de doc revisado, um id de PR aprovado).

Sem gate custom declarado para a fase, não invente um cruzamento — a lacuna fica
sem prova formal nesta versão (v1), e isso é uma decisão aceita, não um bug.
