# Schema do `FlowMap`

Forma do frontmatter YAML de `.hexlog/flow.md`, validada por `parseFlowMap`
(`src/flow-map.ts:79`) contra o schema Zod `FlowMap` (`src/flow-map.ts:28-68`).
Leia este arquivo só na hora de escrever o frontmatter (passo 5 do `SKILL.md`) —
não precisa entrar em contexto durante a entrevista ou a leitura das skills apontadas.

## Campos

| Campo | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `phases` | `Name[]` | sim | Nomes de fase, regex de `Name` (`src/events.ts:10`): minúsculo, `[a-z0-9-]`, começa com alfanumérico |
| `process` | `Record<Name, Name>` | sim | Fase → processo. **1:1**: toda fase em `phases` precisa de exatamente um processo mapeado; toda chave aqui precisa existir em `phases` |
| `skills` | `Record<Name, string[]>` | não (default `{}`) | Fase → skills usadas nessa fase. Nome de skill não é `Name` — aceita namespace com `:` (ex. `oh-my-claudecode:ralph`) |
| `gate` | `Record<Name, Name>` | não (default `{}`) | Fase → nome do gate custom daquela fase. O nome precisa já existir via `register_gate` — isso não é checado pelo schema, é responsabilidade do passo 3-4 do `SKILL.md` |
| `targetIdPattern` | `string` | não (default `[^\s:]+`, igual ao regex embutido em `Target`, `src/events.ts:27-30`) | Regex source do `<id>` de `hex:target:<id>`. Só o `<id>` é configurável — o prefixo `hex:target:` é fixo |
| `versions` | `FixedVersions` (opcional) | não | Mesmo formato que `create_process` devolve em `versions` — grave aqui o que a chamada do passo 4 retornou |
| `hook` | `boolean` | não (default `false`) | Ativa o hook `flow-reminder` para este repositório — ver opcional B do `SKILL.md` |
| `editedSkills` | `string[]` | não (default `[]`) | Nomes das skills apontadas na descoberta que a `hexlog-setup` efetivamente editou para chamar a `hexlog-flow` — ver opcional A do `SKILL.md` |

## Validação cruzada (`superRefine`)

Fora do que a tabela acima já garante por tipo, o schema recusa (com `issues`
legíveis, uma por violação):

- Fase em `phases` sem entrada correspondente em `process`.
- Chave em `process`, `skills` ou `gate` que não está em `phases`.

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
hook: false
editedSkills: []
---

# Fluxo pré-código deste projeto

<corpo em markdown com a semântica de cada fase, escrito pela hexlog-setup>
```

O corpo markdown depois do frontmatter é livre — é onde a semântica de cada fase
vive (o servidor guarda só estrutura, não descrição). Ao regravar o frontmatter,
preserve o corpo existente; não gere um corpo genérico por cima do que já foi
escrito numa rodada anterior desta mesma sessão de setup.
