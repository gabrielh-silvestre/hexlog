# Schema do `FlowMap`

Forma do frontmatter YAML de `.hexlog/flow.md`. Especificação autônoma — sem
validador programático nesta v1 (não há consumidor de código, só o agente da
skill `hexlog-flow`, que lê o arquivo como texto). Leia este arquivo só na hora
de escrever o frontmatter (passo 5 do `SKILL.md`) — não precisa entrar em
contexto durante a entrevista ou a leitura das skills apontadas.

## Campos

| Campo | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `phases` | `Name[]` | sim | Nomes de fase, regex de `Name` (`domain/ids.ts#Name`): minúsculo, `[a-z0-9-]`, começa com alfanumérico |
| `process` | `Record<Name, Name>` | sim | Fase → processo. **1:1**: toda fase em `phases` precisa de exatamente um processo mapeado; toda chave aqui precisa existir em `phases` |
| `skills` | `Record<Name, string[]>` | não (default `{}`) | Fase → skills usadas nessa fase. Nome de skill não é `Name` — aceita namespace com `:` (ex. `oh-my-claudecode:ralph`) |
| `gate` | `Record<Name, Name>` | não (default `{}`) | Fase → nome do gate daquela fase. O nome precisa já existir via `define_gate` **e** estar fixado no processo da fase (definido antes do `create_process`) — isso não é checado pelo schema, é responsabilidade do passo 3-4 do `SKILL.md` |
| `targetIdPattern` | `string` | não | Regex source que restringe o rótulo inteiro do `target` (a sintaxe de `Target`, `domain/ids.ts#Target`, vale sempre). Ausente, só a sintaxe do `Target` vale; ver [`../../hexlog-flow/references/target-format.md`](../../hexlog-flow/references/target-format.md) |
| `editedSkills` | `string[]` | não (default `[]`) | Nomes das skills apontadas na descoberta que a `hexlog-setup` efetivamente editou para chamar a `hexlog-flow` — ver o passo opcional do `SKILL.md` |

O campo `versions` do 0.x não existe mais: nenhuma tool devolve a versão que o
processo fixou. O `create_process` devolve só os nomes (`pinned`), e `list` com
`project` e `process` traz `pinned` (os nomes) e `hashes` (um por tipo de
definição). Um
`.hexlog/flow.md` antigo que ainda o traga continua legível — a `hexlog-flow` só lê
os campos acima.

## Validação cruzada

Ao conferir o frontmatter recém-escrito (passo 5 do `SKILL.md`), verifique também:

- Toda fase em `phases` tem entrada correspondente em `process`.
- Toda chave em `process`, `skills` ou `gate` está em `phases`.

## Exemplo mínimo

```yaml
---
phases: [discovery, planning, review]
process:
  discovery: pre-code-discovery
  planning: pre-code-planning
  review: pre-code-review
skills:
  discovery: [grilling]
  planning: [oh-my-claudecode:plan]
gate:
  review: docs-reviewed
editedSkills: []
---

# Fluxo pré-código deste projeto

Projeto hexlog: `meu-projeto`

<corpo em markdown com a semântica de cada fase, escrito pela hexlog-setup>
```

O corpo markdown depois do frontmatter é livre — é onde a semântica de cada fase
vive (o servidor guarda só estrutura, não descrição), e onde fica a frase "Projeto
hexlog: `<nome>`" de que a `hexlog-flow` tira o `project`. Ao regravar o
frontmatter, preserve o corpo existente; não gere um corpo genérico por cima do que
já foi escrito numa rodada anterior desta mesma sessão de setup.
