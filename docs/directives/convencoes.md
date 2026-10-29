# Convenções

## Idioma

- Código: arquivos, pastas, identificadores (funções, tipos, variáveis), nomes de tool MCP, campos de entrada e saída, formato em disco e mensagens em runtime (erros, logs, CLI do instalador) — tudo em **inglês**.
- Títulos de teste (`describe`, `it`) — **inglês**.
- Workflow e script de CI: log e anotação (`echo`, `::error::`, `::warning::`) em **inglês**; o texto que o workflow ou o script publica para um leitor (corpo de PR, comentário, corpo do Release) segue o idioma da documentação, **pt-BR**.
- Comentários de código (incl. JSDoc) e documentação `.md` — **pt-BR**.
- Nomes de arquivo de documentação (`AGENTS.md`, `docs/directives/adr-*.md`, `docs/pesquisa/**`) não são traduzidos.
- Exceção: o texto que o setup escreve no destino (o conteúdo dos `*.template.md`, o bloco do `AGENTS.md` incluído, e os `*.example.json` de `skills/hexlog-setup/references/`) é **inglês**; a prosa em volta, que instrui o agente, segue pt-BR. Ver o item 8 do [ADR 0013](adr-0013-setup-em-repositorio-de-destino.md).

## Escrita dos testes

- Todo caso é `it('should …')`: `should` seguido do comportamento observável, no presente. `test(` e `test.each` não são usados (`it.each`).
- O corpo segue Arrange, Act e Assert, nessa ordem, em blocos separados por uma linha em branco e sem comentário de rótulo. Act é a chamada sob teste; chamada anterior que só prepara estado é Arrange. Arrange vazio some, e o caso de uma linha (`expect(f(x)).toBe(y)`) junta Act e Assert. Um caso prova um comportamento, o do título: chamadas de uma linha que o provam com o mesmo Arrange ficam juntas, como um grupo de `expect`; a variação que pede Arrange próprio vira linha de `it.each`; comportamento distinto vira outro caso. Em `it.each` a tabela é o Arrange; em property test os arbitrários são o Arrange e o `fc.assert` é o Act e o Assert.
- Act que sobe processo filho, bundle ou carga e serve a vários casos pode rodar uma vez no `beforeAll` do `describe` que os agrupa, com o próprio timeout; cada caso é então só o Assert de um comportamento e não muda o resultado compartilhado.
- Asserção sobre o que o próprio Arrange montou (guarda de pré-condição) fecha o Arrange, em bloco próprio, e não é o Assert do caso; asserção sobre o retorno do alvo antes do Act é outro comportamento e vai a outro caso. Laço com `expect` vale quando cada volta prova o comportamento do título sobre outra entrada gerada ou sobre o estado deixado pela volta anterior; lista literal de entradas com Arrange próprio vira `it.each`.
- O `describe` de topo nomeia o que o caso chama: o símbolo exportado no unitário e no budget; a tool, o método do serviço ou o símbolo do adaptador na integração, e o método MCP (`tools/list`, `tools/call`) quando o caso chama a listagem ou o conjunto das tools; o arquivo ou glob verificado no spec de doc e coerência; o artefato executado no e2e. Um arquivo tem um `describe` de topo por alvo.
- Dentro dele cabe no máximo um nível de `describe`, que nomeia a condição comum aos casos (`when …` ou `with …`).

## Núcleo e bordas

- O núcleo (`src/domain/`, `src/shared/`) é puro, e o I/O fica em `src/adapters/`.
- Toda função pura que decide algo (`evaluateGate`, `checkRelation`, `select`, `verifyProcess`) recebe dados já carregados e devolve um valor; nenhuma faz I/O.
- Esquemas Zod para registros e entradas de tools.
- Toda construção de `HexlogError` fica em `src/errors.ts`, nas fábricas nomeadas; `src/`, `scripts/` e `hook/` chamam a fábrica, nunca `new HexlogError`, e só os specs constroem o erro direto. É convenção conferida em review, sem trava no lint.

## Dependências

- Dependências em faixa `^X.Y.Z`, sem `~`, `*` nem `latest`, e a versão resolvida fixada no `package-lock.json` (`npm ci`); `test/package.spec.ts` trava o conjunto de pacotes e o formato da faixa, não a versão.
- Checagem de ausência pelos predicados da es-toolkit, conforme o tipo: `isUndefined` quando só `undefined` é possível, `isNil`/`isNotNil` quando `undefined` e `null` valem. `null` legítimo, sem `undefined` no tipo, segue com `=== null`. Vazio de array ou string fica em `.length`: `isEmpty` só existe em `es-toolkit/compat`, que `src/` não importa.
- Trocar uma lib ou uma decisão exige conferir antes os ADRs de `docs/directives/` e a pesquisa, como descrito em [documentacao.md](documentacao.md).

## Tipos

- Em `src/`, a asserção não nula (`!`) só entra depois de uma checagem que o compilador não estreita sob `noUncheckedIndexedAccess`, como `Object.hasOwn(obj, chave)` antes de `obj[chave]!` ou um índice já limitado pelo tamanho do array; nunca para calar um `undefined` que o tipo admite.

## Hash e listas

- Hash de conteúdo sempre por `sha256hex(canonicalize(valor) ?? '')` (JCS), o mesmo padrão de `src/domain/chain.ts` e da impressão do lote (`fingerprint`) que decide o replay de `register`. **Exceção:** o hash de um anexo é o `sha256hex` dos **bytes** UTF-8 do texto, não do JCS, porque o blob é texto opaco e não um objeto JSON.
- Toda lista de saída tem teto e diz o que cortou: `breaks` e `attachmentBreaks` em 100 por `verify_chain`, com o total ao lado; `repairedLines` em 100 sem total; `changes` e `evidence` em 100, com `omitted`; `query` e `read_attachment` por página de até `PAGE_CHARS_CAP` (24.000 caracteres, contados no JSON da página na `query` e nos caracteres do `text` no `read_attachment`). Os tetos do domínio estão em [tetos-dominio-v1.md](../tetos-dominio-v1.md).

## Escrita em disco

- Toda escrita de `process.json` e de definição usa `src/adapters/fs/atomic.ts#writeFileAtomic` (temporário no mesmo diretório, `fsync`, depois `rename` ou `link` exclusivo), nunca escrita direta no arquivo final.
- A escrita de uma versão de definição é sempre por `link` exclusivo: `rename` sobrescreveria em silêncio sob corrida entre dois `define_*` no mesmo alvo, e em `EEXIST` o retry refaz a decisão inteira (vigente, `unchanged`, quebra, bump).

## Import padrão de fs

Módulo de `src/adapters/fs/` que um spec espiona com `jest.spyOn(fs, ...)` usa `import fs from 'node:fs'` (import padrão), nunca `import * as fs`. Sob `esModuleInterop` o namespace copia o módulo com getters não configuráveis, e o spy só intercepta o objeto padrão. Os comentários de `src/adapters/fs/` e de `src/archive.ts` apontam para esta seção.

## import()

`import()` não é usado: o lint o barra nas camadas com bloco (ver [fronteiras.md](fronteiras.md)), e fora delas a regra é convenção, que hoje nenhum arquivo quebra.
