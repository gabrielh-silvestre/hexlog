# Modelo declarativo (`hexlog-model.json`)

O modelo é o dado do setup: o que o hexlog precisa saber do fluxo de um projeto de destino. Fica ao lado da `SKILL.md` do projeto, em `.claude/skills/<projeto>-hexlog/`, em JSON puro e em inglês. Só o setup o altera: ele o **regenera** a partir da entrevista ou da descoberta, e o uso da unidade o lê como dado. Exemplos completos: `three-phase-model.example.json` e `minimal-model.example.json`.

## Campos de topo

| Campo | Tipo | O que é |
|---|---|---|
| `schema` | inteiro | Versão do formato do modelo. Hoje só `1`; valor desconhecido faz a mecânica parar e pedir o setup de novo |
| `project` | texto | Nome do projeto hexlog (regra de nome do hexlog) |
| `unit` | objeto | A unidade de trabalho (abaixo) |
| `phases` | lista | As fases, em ordem (abaixo) |
| `types` | lista | Um `{ name, schema }` por tipo de registro, com a forma dos argumentos de `define_type` |
| `relations` | lista | Um `{ name, kind, from, to }` por nome de relação, com a forma de `define_relation` |
| `gate` | objeto | `{ name, questions }`, com a forma de `define_gate` |
| `targetPattern` | texto, opcional | Formato fixo de rótulo do projeto, quando a sintaxe padrão de target não serve |
| `ownerSeat` | objeto, opcional | A cadeira do dono (abaixo). Ausente = cadeira desligada |

## `unit`

| Campo | O que é |
|---|---|
| `kind` | O que é uma unidade neste projeto (pasta de feature, ticket, pedido de mudança) |
| `location` | Onde ela vive no repositório, com marcador de lugar |
| `examples` | Lista de `{ path, process }` reais, com `process` válido e distinto |

**Forma canônica do caminho da unidade.** Caminho relativo à raiz do repositório, separador POSIX (`/`), do primeiro ao último segmento (por exemplo `docs/features/photo-albums`). É a única forma gravada e comparada no campo `unit` dos registros: o sufixo de colisão ou de reabertura vive só no nome do processo.

**Nome do processo.** Minúsculas; cada sequência de caracteres fora de `[a-z0-9]` vira um único `-`; `-` só entre caracteres, inclusive depois de truncar em 63 caracteres; vazio, nome reservado ou colisão com outra unidade leva um sufixo confirmado com o dev (a mecânica está em `hexlog-flow`, `references/unit-lifecycle.md`).

## `ownerSeat`

Presente só quando o dev ligou a cadeira do dono (procedimento em `owner-seat.md`). As definições do pacote dela **não** entram em `types`, `relations` nem `gate`: o gate `gaps` não cabe no campo `gate`, que é singular, e o pacote tem registro próprio aqui.

| Campo | O que é |
|---|---|
| `names` | Objeto: o nome **aplicado** de cada definição do pacote, com as chaves `type_gap`, `type_premise`, `type_evidence`, `type_audit`, `relation_fills_gap`, `relation_audits` e `gate_gaps` (as mesmas dos placeholders de geração dos templates). O valor é o nome padrão ou o nome mapeado numa colisão |
| `applied` | Objeto com as mesmas chaves de `names`: a versão de cada definição, lida do `list` depois do registro. É o único lugar em que a versão do pacote vive |
| `occupant` | `claude`, `agy` ou `none` (cadeira ligada, sem ocupante) |

**Sem caminho absoluto, `~` nem `$HOME`**, em nenhum campo: o doc de critérios fica num lugar fixo da pasta da skill do projeto (`owner-seat/criteria.md`), então não precisa de campo, e o caminho do checkout do hexlog vem da variável `HEXLOG_CHECKOUT` de cada dev, nunca de arquivo versionado.

## `phases[]`

| Campo | O que é |
|---|---|
| `name` | Nome da fase |
| `command` | Comando ou ação que dispara a fase |
| `type` | Nome do tipo de registro da fase (um de `types`) |
| `target` | Sufixo do target: o registro vai para `<processo>.<target>`, o mesmo formato da mecânica da `hexlog-flow` |
| `artifact` | Arquivo que a fase produz |
| `links` | Lista de `{ relation, to }`: nome de relação (um de `relations`) e o tipo de destino |

## Regras dos tipos de fase

- Todo tipo de fase tem o campo `unit` (texto, `maxLength` 200), **obrigatório desde a primeira versão do tipo**. Assim a consulta por `where` acha a unidade qualquer que seja o primeiro registro dela, mesmo com fases registradas fora de ordem.
- Campo que guarda hash de anexo leva a marca `format: "attachment"` desde a primeira versão: regra e custo na seção "Conferência de anexo" do `SKILL.md` do setup.
- O schema do tipo descreve formato com `format`, `maxLength` e afins; `pattern` e `patternProperties` são recusados pelo servidor.

## Gate

O gate proposto cobre dois eixos:

- **Cobertura**: um `occurred` por tipo de fase.
- **Encadeamento**: um `no_pending` para cada fase que tem sucessora, resolvido pela espécie de relação `derivesFrom` a partir do tipo da sucessora. A fase fica pendente até a sucessora derivar dela, e um registro de fase sem sucessora ligada reprova o gate. O exemplo completo está em `three-phase-model.example.json`.

O dev pode recusar o encadeamento, mas a proposta nasce com ele. As fases de uma unidade vivem no mesmo processo, então o gate lê o processo da unidade (alcance padrão); `scope: "project"` entra para cruzar unidades diferentes.
