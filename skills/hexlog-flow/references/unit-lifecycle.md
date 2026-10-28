# Ciclo de vida da unidade de trabalho

Mecânica de abrir, continuar e fechar uma unidade de trabalho (uma feature, uma spec, uma tarefa: o que o modelo do projeto chama de `unit`). Um processo do hexlog por unidade. A skill do projeto traz só os dados (a tabela de fases, o `project`, o `gate`, o caminho da unidade) e aponta para cá; as regras abaixo valem para qualquer projeto e chegam a todos pela reinstalação, sem regerar a skill do projeto. Carregue este arquivo ao abrir, continuar ou fechar uma unidade.

## 1. Versão do modelo

O modelo do projeto declara `schema`, um inteiro. A mecânica deste arquivo entende só `schema` igual a `1`. Valor desconhecido: pare e peça ao desenvolvedor que rode a hexlog-setup de novo. O modelo fica congelado no repositório de destino e esta mecânica evolui por reinstalação, então os dois podem se descolar.

## 2. Resolver o processo da unidade

Todo tipo de fase carrega o campo `unit`, o caminho canônico da unidade (relativo à raiz do repositório, separador `/`, sem barra final e sem `./`). Ache o processo pelos registros:

```text
query({ project, scope: "project", where: { unit: "<caminho da unidade>" },
        fields: ["unit"], limit: 50 })
```

Cada fase registrada dá um acerto, então `limit: 1` esconderia a diferença entre processos. Agrupe os acertos pelo prefixo do `id` antes de `:` (`domain/ids.ts#RecordId`, que é o nome do processo):

- um processo: é ele, siga;
- mais de um (a unidade foi reaberta, passo 4): vale o de maior sufixo numérico no nome, sendo o nome sem sufixo o de número 1; os anteriores estão aposentados e ficam sem registro novo. Se os nomes fogem desse padrão de sufixo, pare e pergunte ao desenvolvedor qual vale;
- nenhum acerto: passo 3.

`PROJECT_NOT_FOUND` ou `TYPE_NOT_FOUND` na consulta ou no `create_process` significam que o modelo ainda não foi aplicado neste hexlog: siga o passo 7. `PROCESS_CORRUPTED` na consulta significa cadeia quebrada em algum processo do projeto. Relate ao desenvolvedor, sugira `verify_chain` por processo e **pare**: o nome calculado do passo 3 poderia colidir com o processo quebrado.

## 3. Sem acerto: calcular o nome e criar

Calcule o nome do processo a partir da unidade, no formato de `domain/ids.ts#Name`:

1. minúsculas;
2. cada sequência de caracteres fora de `[a-z0-9]` vira um único `-`;
3. trunque em 63 caracteres;
4. tire `-` das pontas (depois de truncar, para o nome terminar sem `-`).

Nome vazio ou igual a um valor de `RESERVED_PROCESS_NAMES`: acrescente um sufixo e confirme com o desenvolvedor. Chame `create_process`:

- `created: true`: siga.
- `created: false`: o nome já existe. Faça `query` do processo (`process`, `limit: 1`, `fields: ["unit"]`). Sem registro, adote o processo (sobra vazia). Registro com outra `unit` é colisão de nomes de unidades diferentes: peça ao desenvolvedor um sufixo e repita.

O sufixo vive só no **nome do processo**: o campo `unit` guarda sempre o caminho canônico, sem sufixo. As fases seguintes acham o processo pelo `unit` (passo 2), e o nome com sufixo vem do id dos acertos. Ao reabrir uma unidade (passo 4), o processo novo leva o próximo sufixo numérico (`-2`, `-3`, ...), truncando a base para o nome caber em 63 caracteres; o anterior fica aposentado, e o passo 2 elege o novo pelo maior sufixo.

## 4. `stale` e `TYPE_NOT_PINNED`

A cada fase, chame `create_process` (é idempotente) e leia `stale`. O processo fixou as versões do projeto quando nasceu: definição criada depois fica de fora dele. `stale` compara o projeto inteiro (`commands/process.ts#staleOf`) e dá falso alarme para um tipo que esta unidade nem usa. Por isso avise o desenvolvedor **só se o tipo exigido pela próxima fase está em `stale` ou ausente do que o processo fixou**. Então proponha fechar a unidade (passo 6) ou reabri-la em processo novo, com o próximo sufixo do passo 3 (o anterior fica aposentado); as versões fixadas de um processo existente ficam como nasceram. Registrar num tipo não fixado dá `TYPE_NOT_PINNED`: pare e avise.

## 5. Registrar uma fase

Use `target` no formato `<processo>.<target da tabela de fases>` (a coluna de target da fase no modelo, que pode diferir do nome da fase), o `unit` em `data`, as relações que a tabela de fases do modelo declara e uma `key`, conforme a árvore de decisão do `SKILL.md`. Campo de anexo pede `attach` antes (ver "Anexos" no `SKILL.md`).

**Relações da fase.** Para cada `links` da fase, faça `query` do processo pelo registro vigente do tipo de destino e grave a relação nomeada apontando para o id dele.

**Fase com registro vigente** (a fase foi reexecutada, por exemplo um segundo `/speckit-plan`). Antes de gravar, faça `query` do processo pelo target da fase. Se há registro vigente, grave o novo no mesmo target com `supersedes` do id vigente e regrave as relações do antigo. Cada registro vigente de fase sucessora que tinha `derivesFrom` (ou a relação da tabela) apontando para o antigo é regravado do mesmo modo: `supersedes` dele, mesmos dados e a relação apontando para o novo. Sem isso o `no_pending` do gate reprova a unidade, porque a sucessora aponta para um registro superado.

**`key`.** Ela identifica a intenção do lote, não a fase (regra geral na seção "`key`" do `SKILL.md`). O reenvio do mesmo lote (erro incerto) repete a `key`; a reexecução da fase é lote diferente e leva `key` nova (por exemplo `<target>:abertura` na primeira vez e `<target>:reexecucao-2` na seguinte), porque a mesma `key` com lote diferente é `IDEMPOTENCY_CONFLICT`.

## 6. Fechar a unidade

1. `evaluate_gate` com o gate do modelo e o processo da unidade.
2. `query` do processo, conferindo que há um registro vigente por fase da tabela.
3. Fase sem registro: avise o desenvolvedor, liste as fases faltantes e ofereça o **registro retroativo**, montado a partir do `artifact` que a tabela declara para cada fase.

Diante de uma fase faltante, deixe o arquivo do modelo e o campo `plug.layer` como estão: o modelo descreve a configuração, e só a hexlog-setup o muda.

## 7. Projeto sem definições

`PROJECT_NOT_FOUND` na consulta do passo 2, ou `create_process` com `TYPE_NOT_FOUND` (`errors.ts#noDefinitions`), quer dizer que o projeto está ausente deste hexlog ou ainda sem definição alguma: o modelo não foi aplicado aqui (clone em outra máquina, dado novo). Pare e mande rodar a hexlog-setup, que reaplica o modelo que está no repositório sem nova entrevista.
