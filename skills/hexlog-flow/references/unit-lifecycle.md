# Ciclo de vida da unidade de trabalho

Mecânica de abrir, continuar e fechar uma unidade de trabalho (uma feature, uma
spec, uma tarefa: o que o modelo do projeto chama de `unit`). Um processo do
hexlog por unidade. A skill do projeto traz só os dados (a tabela de fases, o
`project`, o `gate`, o caminho da unidade) e aponta para cá; as regras abaixo
valem para qualquer projeto e chegam a todos pela reinstalação, sem regerar a
skill do projeto. Carregue este arquivo ao abrir, continuar ou fechar uma unidade.

## 1. Versão do modelo

O modelo do projeto declara `schema`, um inteiro. A mecânica deste arquivo entende
só `schema` igual a `1`. Valor desconhecido: pare e peça ao desenvolvedor que rode
a hexlog-setup de novo. O modelo fica congelado no repositório de destino e esta
mecânica evolui por reinstalação, então os dois podem se descolar.

## 2. Resolver o processo da unidade

Todo tipo de fase carrega o campo `unit`, o caminho canônico da unidade (relativo à
raiz do repositório, separador `/`, sem barra final e sem `./`). Ache o processo
pelos registros:

```text
query({ project, scope: "project", where: { unit: "<caminho da unidade>" },
        fields: ["unit"], limit: 50 })
```

Cada fase registrada dá um acerto, então `limit: 1` não distinguiria processos
diferentes. Agrupe os acertos pelo prefixo do `id` antes de `:`
(`domain/ids.ts#RecordId`, que é o nome do processo):

- um processo: é ele, siga;
- mais de um: pare e pergunte ao desenvolvedor qual vale;
- nenhum acerto: passo 3.

`PROJECT_NOT_FOUND` ou `TYPE_NOT_FOUND` na consulta ou no `create_process` significam que o
modelo ainda não foi aplicado neste hexlog: siga o passo 7. `PROCESS_CORRUPTED` na consulta significa cadeia quebrada em algum processo do
projeto. Relate ao desenvolvedor, sugira `verify_chain` por processo e **não caia
no nome calculado**: ele poderia colidir com o processo quebrado.

## 3. Sem acerto: calcular o nome e criar

Calcule o nome do processo a partir da unidade, no formato de `domain/ids.ts#Name`:

1. minúsculas;
2. cada trecho fora de `[a-z0-9]` vira `-`;
3. tire `-` das pontas;
4. trunque em 63 caracteres.

Nome vazio ou igual a um valor de `RESERVED_PROCESS_NAMES`: acrescente um sufixo e
confirme com o desenvolvedor. Chame `create_process`:

- `created: true`: siga.
- `created: false`: o nome já existe. Faça `query` do processo (`process`, `limit: 1`,
  `fields: ["unit"]`). Sem registro, adote o processo (sobra vazia). Registro com
  outra `unit` é colisão de nomes de unidades diferentes: peça ao desenvolvedor um
  sufixo e repita.

O sufixo escolhido fica persistido pelos próprios registros (campo `unit`), então as
fases seguintes acham o processo pelo passo 2.

## 4. `stale` e `TYPE_NOT_PINNED`

A cada fase, chame `create_process` (é idempotente) e leia `stale`. O processo fixou
as versões do projeto quando nasceu: definição criada depois não vale para ele.
`stale` compara o projeto inteiro (`commands/process.ts#staleOf`) e dá falso alarme
para um tipo que esta unidade nem usa. Por isso avise o desenvolvedor **só se o
tipo exigido pela próxima fase está em `stale` ou ausente do que o processo
fixou**. Então proponha fechar a unidade ou abrir outra, nunca fixar de novo. Registrar
num tipo não fixado dá `TYPE_NOT_PINNED`: pare e avise.

## 5. Registrar uma fase

Use `target` no formato `<processo>.<fase>`, o `unit` em `data`, as relações que a
tabela de fases do modelo declara e uma `key` estável, conforme a árvore de decisão
do `SKILL.md`. Campo de anexo exige `attach` antes (ver "Anexos" no `SKILL.md`).

## 6. Fechar a unidade

1. `evaluate_gate` com o gate do modelo e o processo da unidade.
2. `query` do processo, conferindo que há um registro vigente por fase da tabela.
3. Fase sem registro: avise o desenvolvedor, liste as fases faltantes e ofereça o
   **registro retroativo**, montado a partir do `artifact` que a tabela declara para
   cada fase.

Nunca altere o arquivo do modelo nem o campo `plug.layer` por causa de uma fase
faltante: o modelo descreve a configuração e só a hexlog-setup o muda.

## 7. Projeto sem definições

`PROJECT_NOT_FOUND` na consulta do passo 2, ou `create_process` com `TYPE_NOT_FOUND`
(`errors.ts#noDefinitions`), quer dizer que o projeto não existe neste hexlog ou ainda não
tem nenhuma definição: o modelo não foi aplicado aqui (clone em outra máquina, dado novo).
Pare e mande rodar a hexlog-setup, que reaplica o modelo que está no repositório sem nova
entrevista.
