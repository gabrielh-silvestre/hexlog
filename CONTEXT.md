# Produto

O hexlog guarda o que agentes registram como um log append-only e verificável, para que decisões, marcos e evidências possam ser consultados e auditados depois.

## Language

### Onde se grava

**Projeto** (`project`):
Espaço com nome que guarda as definições e os processos de um mesmo assunto.
_Avoid_: workspace, repositório

**Processo** (`process`):
Um log append-only de registros, com as definições que ele fixou ao nascer.
_Avoid_: stream, log (como nome do conceito), trabalho

**Alcance** (`scope`):
O conjunto que uma leitura enxerga: um processo só, ou todos os processos do projeto.
_Avoid_: escopo

**Marcador** (`marker`):
O último registro lido de cada processo, de onde uma leitura seguinte continua.
_Avoid_: cabeça, head, cursor

### O que se grava

**Registro** (`record`):
Um fato imutável gravado num processo, com tipo, target, autor, dados e relações.
_Avoid_: entrada, evento, marco, veredito, record (na prosa)

**Lote** (`batch`):
De 1 a 50 registros gravados juntos, todos ou nenhum.
_Avoid_: transação, batch (na prosa)

**Apelido** (`alias`):
Nome que um item do lote recebe para ser citado pelos itens seguintes do mesmo lote.
_Avoid_: rótulo, label

**Target**:
Caminho com pontos que diz sobre o que é o registro; um prefixo casa só na fronteira do ponto.
_Avoid_: alvo, assunto

**Autor** (`author`):
Quem gravou o registro: o agente, o modelo declarado e o cliente MCP.
_Avoid_: usuário, owner

**Anexo** (`attachment`):
Texto guardado à parte, endereçado pelo próprio hash e citado por um campo do registro.
_Avoid_: arquivo, blob (na prosa)

### Relações

**Relação** (`relation`):
Ligação de um registro para outro, com uma espécie e, opcionalmente, um nome.
_Avoid_: link, aresta, referência

**Espécie de relação** (`kind`):
Uma das oito ligações que o hexlog fixa, como `supersedes` ou `supports`.
_Avoid_: tipo de relação, kind (na prosa)

**Nome de relação** (`as`):
Definição com que o projeto batiza uma espécie de relação, podendo restringir os tipos de registro de cada ponta.
_Avoid_: alias, rótulo, relação nomeada

**Ponta**:
Cada um dos dois registros de uma relação: a origem, que grava, e o destino, para onde aponta.
_Avoid_: endpoint, nó, lado

**Herança de relações** (`lineageInheritance`):
Leitura em que uma relação gravada vale também para a versão atual de uma ponta superada, sem regravar nada; só existe no processo que nasceu com ela.
_Avoid_: propagação, cópia de relações

**Apoio morto**:
Um `supports` que deixou de valer porque uma das pontas saiu de vigência sem que a versão atual dela o recebesse; a ponta ainda vigente fica marcada para revisão.
_Avoid_: apoio quebrado, relação órfã

### Definições

**Definição**:
Um tipo de registro, um nome de relação ou um gate, versionado no projeto.
_Avoid_: schema (para o conjunto), config

**Tipo de registro** (`type`):
Definição que dá nome a uma espécie de registro e valida os dados dele.
_Avoid_: schema, categoria

**Fixar** (`pinned`, `fixed`):
O processo copiar, ao nascer, a versão de cada definição do projeto; o que ele fixou não muda depois.
_Avoid_: pinar, travar, pinned (na prosa)

**Manifesto** (`process.json`):
O que o processo fixou ao nascer, e a raiz da cadeia dele.
_Avoid_: metadados, cabeçalho

### Integridade

**Elo** (`link`):
O registro como ele fica na cadeia, ligado ao elo anterior pelo hash.
_Avoid_: link (na prosa), linha

**Cadeia**:
A sequência de elos de um processo, encadeada por hash a partir da âncora.
_Avoid_: hash chain (na prosa), histórico

**Âncora** (`anchor`):
O hash do manifesto, de onde a cadeia parte.
_Avoid_: raiz, gênese

**Cabeça** (`head`):
O hash do último elo da cadeia; num processo vazio, a âncora.
_Avoid_: topo, último registro

### Vigência

**Vigente** (`current`):
Registro que nenhum outro superou nem revogou.
_Avoid_: ativo, válido, current (na prosa)

**Versão atual**:
O único vigente de uma linhagem, se houver.
_Avoid_: última versão, mais recente

**Superar** (`supersedes`):
Gravar um registro novo que substitui um vigente do mesmo tipo e target.
_Avoid_: sobrescrever, atualizar, editar

**Revogar** (`revokes`):
Gravar um registro que tira um vigente de vigência sem pôr outro no lugar.
_Avoid_: apagar, deletar, cancelar

**Linhagem**:
Os registros ligados entre si por superação; tem no máximo um vigente, e nenhum quando foi revogada.
_Avoid_: histórico, versões, cadeia

**Bifurcação** (`fork`):
Uma linhagem com dois vigentes, que a gravação recusa.
_Avoid_: conflito, divergência

### Gates

**Gate**:
Definição com perguntas sobre os registros, avaliada sem gravar nada.
_Avoid_: portão, checagem, validação

**Pergunta de gate**:
Uma condição do gate: algo aprovado, algo ocorrido, nada pendente ou nenhuma contradição aberta.
_Avoid_: regra, critério

**Evidência do gate** (`evidence`):
Os registros que sustentam a resposta de cada pergunta de um gate.
_Avoid_: evidência (sozinha), prova

### Setup em repositório de destino

**Repositório de destino**:
O repositório de código de um projeto externo onde o setup gera os artefatos do hexlog; o **Projeto** hexlog que o acompanha é o espaço do log, outra coisa.
_Avoid_: projeto alvo, alvo (colide com **Target**), projeto (é o espaço do log)

**Skill do projeto**:
A skill curta que o setup gera no repositório de destino, com a tabela de fases e ponteiros para a mecânica da `hexlog-flow`.
_Avoid_: skill gerada (sozinha), mapa do fluxo

**Modelo declarativo** (`hexlog-model.json`):
O arquivo, ao lado da skill do projeto, com a unidade, as fases, os tipos, as relações e o gate que o setup registrou; regenerado, nunca editado em uso.
_Avoid_: mapa, configuração

**Unidade de trabalho** (`unit`):
O que recebe um **Processo** no repositório de destino, como uma pasta de feature; identificada pelo caminho canônico.
_Avoid_: trabalho (o glossário do fluxo usa o termo para as entregas deste repositório), tarefa

### Cadeira do dono no produto

**Cadeira do dono**:
O recurso opt-in do setup em que um modelo responde as lacunas do agente executor com base em critérios do projeto, grava a resposta no hexlog e deixa o humano auditar depois. Não é a cadeira do fluxo de desenvolvimento deste repositório, que exige aval prévio na classe crítica ([adr-0014-cadeira-do-dono-como-pacote-de-dados.md](docs/directives/adr-0014-cadeira-do-dono-como-pacote-de-dados.md)).
_Avoid_: oráculo, aprovador

**Ocupante**:
O modelo (Claude ou `agy`) que responde a lacuna na cadeira do produto, ou o humano quando o setup não define ocupante; a resposta carrega `answeredBy` (`human` ou `simulated`).
_Avoid_: respondente, revisor, critic (termo do fluxo de desenvolvimento)

**Aval** (`audit`):
O registro com que o humano confere uma resposta do ocupante, ligado a ela pela relação `audits`; contestar é gravar uma resposta humana nova com `revokes` da anterior.
_Avoid_: aprovação, veredito
