# Modelo declarativo (`hexlog-model.json`)

O modelo é o dado do setup: o que o hexlog precisa saber do fluxo de um projeto de
destino. Fica ao lado da `SKILL.md` gerada, em `.claude/skills/<projeto>-hexlog/`, em
JSON puro e em inglês. O setup o **regenera** a partir da entrevista ou da descoberta;
ninguém o edita à mão durante o uso. Exemplos completos:
`speckit-model.example.json` e `minimal-model.example.json`.

## Campos de topo

| Campo | Tipo | O que é |
|---|---|---|
| `schema` | inteiro | Versão do formato do modelo. Hoje só `1`; valor desconhecido faz a mecânica parar e pedir o setup de novo |
| `modelVersion` | inteiro | Sobe **só com mudança semântica** do modelo; regenerar sem mudança não o altera |
| `project` | texto | Nome do projeto hexlog (regra de nome do hexlog) |
| `language` | texto | Idioma da saída gerada; sempre `"en"` |
| `unit` | objeto | A unidade de trabalho (abaixo) |
| `phases` | lista | As fases, em ordem (abaixo) |
| `types` | lista | Um `{ name, schema }` por tipo de registro, com a forma dos argumentos de `define_type` |
| `relations` | lista | Um `{ name, kind, from, to }` por nome de relação, com a forma de `define_relation` |
| `gate` | objeto | `{ name, questions }`, com a forma de `define_gate` |
| `targetPattern` | texto, opcional | Formato fixo de rótulo do projeto, quando a sintaxe padrão de target não serve |
| `plug` | objeto | `{ flow, flowVersion, layer }`: a camada configurada para o fluxo (`layer` é `C`, `B` ou `A`). Descreve o que o setup fez e **nunca é editado em tempo de uso** |

## `unit`

| Campo | O que é |
|---|---|
| `kind` | O que é uma unidade neste projeto (pasta de feature, ticket, pedido de mudança) |
| `location` | Onde ela vive no repositório, com marcador de lugar |
| `processName` | Como o caminho da unidade vira nome de processo |
| `examples` | Lista de `{ path, process }` reais, com `process` válido e distinto |

**Forma canônica do caminho da unidade.** Caminho relativo à raiz do repositório,
separador POSIX (`/`), sem barra final e sem `./` (por exemplo
`specs/001-photo-albums`). É a única forma gravada e comparada.

**Nome do processo.** Minúsculas; cada trecho fora de `[a-z0-9]` vira `-`; sem `-` nas
pontas; até 63 caracteres; vazio ou nome reservado leva um sufixo confirmado com o dev.

## `phases[]`

| Campo | O que é |
|---|---|
| `name` | Nome da fase |
| `command` | Comando ou ação que dispara a fase |
| `type` | Nome do tipo de registro da fase (um de `types`) |
| `target` | Sufixo do target: o registro vai para `<processo>.<target>` |
| `artifact` | Arquivo que a fase produz |
| `links` | Lista de `{ relation, to }`: nome de relação (um de `relations`) e o tipo de destino |

## Regras dos tipos de fase

- Todo tipo de fase tem o campo `unit` (texto, `maxLength` 200), **obrigatório desde a
  primeira versão do tipo**. Assim a consulta por `where` acha a unidade qualquer que
  seja o primeiro registro dela, mesmo com fases registradas fora de ordem.
- Campo que guarda hash de anexo leva `format: "attachment"` no primeiro nível, desde a
  primeira versão.
- Sem `pattern` nem `patternProperties`: o servidor os recusa.

## Gate

Cobertura: um `occurred` por tipo de fase. Encadeamento: um `no_pending` por fase que
tem sucessora, resolvido pela relação que liga a sucessora. As fases de uma unidade vivem
no mesmo processo, então o gate lê o processo da unidade sem `scope`; `scope: "project"` só
entra para cruzar unidades diferentes.
