# Convenções

## Idioma

- Código: arquivos, pastas, identificadores (funções, tipos, variáveis), nomes de tool MCP, campos de entrada e saída, formato em disco e mensagens em runtime (erros, logs, CLI do instalador) — tudo em **inglês**.
- Comentários de código (incl. JSDoc), títulos de teste e documentação `.md` — **pt-BR**.
- Nomes de arquivo de documentação (`AGENTS.md`, `docs/directives/adr-*.md`, `docs/pesquisa/**`) não são traduzidos.

## Núcleo e bordas

- O núcleo (`src/domain/`, `src/shared/`) é puro, e o I/O fica em `src/adapters/`.
- Toda função pura que decide algo (`evaluateGate`, `checkRelation`, `select`, `verifyProcess`) recebe dados já carregados e devolve um valor; nenhuma faz I/O.
- Esquemas Zod para registros e entradas de tools.

## Dependências

- Versões de dependências fixadas, sem `^` nem `~`; `test/package.spec.ts` trava.
- Checagem de ausência pelos predicados da es-toolkit, conforme o tipo: `isUndefined` quando só `undefined` é possível, `isNil`/`isNotNil` quando `undefined` e `null` valem. `null` legítimo, sem `undefined` no tipo, segue com `=== null`. Vazio de array ou string fica em `.length`: `isEmpty` só existe em `es-toolkit/compat`, que `src/` não importa.
- Trocar uma lib ou uma decisão exige conferir antes os ADRs de `docs/directives/` e a pesquisa, como descrito em [documentacao.md](documentacao.md).

## Hash e listas

- Hash de conteúdo sempre por `sha256hex(canonicalize(valor) ?? '')` (JCS), o mesmo padrão de `src/domain/chain.ts` e da impressão do lote (`fingerprint`) que decide o replay de `register`. **Exceção:** o hash de um anexo é o `sha256hex` dos **bytes** UTF-8 do texto, não do JCS, porque o blob é texto opaco e não um objeto JSON.
- Toda lista de saída tem teto e diz o que cortou: `breaks` e `attachmentBreaks` em 100 por `verify_chain`, com o total ao lado; `repairedLines` em 100 sem total; `changes` e `evidence` em 100, com `omitted`; `query` e `read_attachment` por página de até `PAGE_CHARS_CAP` (24.000 caracteres, contados no JSON da página na `query` e nos caracteres do `text` no `read_attachment`). Os tetos do domínio estão em [tetos-dominio-v1.md](../tetos-dominio-v1.md).

## Escrita em disco

- Toda escrita de `process.json` e de definição usa `src/adapters/fs/atomic.ts#writeFileAtomic` (temporário no mesmo diretório, `fsync`, depois `rename` ou `link` exclusivo), nunca escrita direta no arquivo final.
- A escrita de uma versão de definição é sempre por `link` exclusivo: `rename` sobrescreveria em silêncio sob corrida entre dois `define_*` no mesmo alvo, e em `EEXIST` o retry refaz a decisão inteira (vigente, `unchanged`, quebra, bump).

## Import padrão de fs

Módulo de `src/adapters/fs/` que um spec espiona com `jest.spyOn(fs, ...)` usa `import fs from 'node:fs'` (import padrão), nunca `import * as fs`. Sob `esModuleInterop` o namespace copia o módulo com getters não configuráveis, e o spy (P9, M25 da issue #63) só intercepta o objeto padrão. Os comentários de `src/adapters/fs/` e de `src/archive.ts` apontam para esta seção.

## import()

`import()` não é usado: o lint o barra nas camadas com bloco (ver [fronteiras.md](fronteiras.md)), e fora delas a regra é convenção, que hoje nenhum arquivo quebra.
