# Invariantes

O que o código garante e nenhuma mudança pode quebrar. Onde um ADR cobre a regra, a linha só aponta o ADR e o item.

## Log e cadeia

- O log é estritamente append-only, gravado sob lock por processo. `src/adapters/fs/process-store.ts` só abre o `records.jsonl` em modo `'a'` e faz `fsync` antes de fechar, com teto `MAX_LOG_BYTES`. Nunca crie código que edite ou remova linha: não existe tool nem função de reescrita, e a alteração externa é detectada por `verify_chain` ([ADR 0009](adr-0009-ferramental.md), itens 10 e 19).
- A leitura e a escrita do log usam um único predicado, `isValidLine` em `src/shared/loader.ts`. Não duplique essa lógica. Ele devolve `LineCheck` (`valid`, `torn` ou `rejected` com `reasons`), conferido elo a elo por `isValidLink` em `src/domain/chain.ts`. Regra de sequência e de cauda rasgada: [ADR 0009](adr-0009-ferramental.md), item 10.
- A cadeia é `hashLink` sobre o JCS do elo sem `prevHash`; a raiz é `anchor(manifest)` em `src/domain/chain.ts`. O manifesto fixa as versões das definições e é imutável.
- Lock por processo em `src/adapters/fs/lock.ts` (`createLockManager`): publicado por `rename`, dono por pid, `bootId` e token; órfão é roubado, dono vivo nunca. A seção crítica (decidir e escrever o lote) é síncrona, sem `await`. Premissa de pid, tetos e destravamento manual: [ADR 0009](adr-0009-ferramental.md), itens 2, 3 e 18.
- Um `register` é um lote numa só linha de um só processo. `supersedes` e `revokes` só alcançam registro do próprio processo ([ADR 0007](adr-0007-dominio.md), item 5).
- Os dados 1.0 vivem só em `<D>/.v1/` (`src/adapters/fs/data-format.ts#dataRoot`); dado 0.x em `<D>` é recusado com `LEGACY_DATA` até o instalador arquivá-lo ([ADR 0009](adr-0009-ferramental.md), itens 9 e 13).

## Tools

- São exatamente 12 tools ([ADR 0009](adr-0009-ferramental.md), item 1 e a emenda de 2026-10-06), fixadas por `installation.ts#TOOLS_COUNT` e conferidas pelo instalador antes de trocar o artefato. Adicionar ou remover uma quebra os testes do instalador e do e2e.
- Toda tool passa por `execute()` em `src/mcp/kernel.ts`, que nunca deixa uma exceção chegar ao SDK: `HexlogError` vira `{code, message, details}` e qualquer outra exceção vira `INTERNAL`, com a stack só no log `internal-error`, nunca na resposta.
- O log `tool` de `execute` leva `name`, `ms` e `code?`, nunca o conteúdo da entrada nem `project`/`process` (o teste de privacidade o proíbe).
- Todo erro de domínio é uma `HexlogError` com um código de `ErrorCode` (`src/errors.ts`). `details` é sempre um array de `{ path, code, message }`, com `path` em JSON Pointer (RFC 6901); erro de Zod vira `details[]` por `issueDetails` ([ADR 0009](adr-0009-ferramental.md), itens 7 e 11).
- Leitura de definição não cabe como parâmetro de uma tool existente: entra como tool própria, com emenda datada ao [ADR 0009](adr-0009-ferramental.md), item 1 (a 12ª tool, `describe_type`, é o precedente).
- `describe_type` (`src/queries/describe-type.ts#createDescribeType`) lê só tipos: o fixado no processo, com `process`, ou a versão vigente ou pedida do projeto, sem `process`; relações e gates ficam fora.
- `describe_type` com `process` e `version` juntos é `INVALID_INPUT` (`/version`, `process-with-version`), recusado no serviço antes de qualquer I/O.
- `describe_type` com `process` e tipo não fixado é `TYPE_NOT_PINNED` (`/type`, `not-pinned`); sem `process`, tipo ou versão ausente do projeto é `TYPE_NOT_FOUND`.
- `describe_type` com `process` omite `version` da saída, porque o manifesto guarda o schema fixado (`Manifest.fixed.types`), não a versão.
- `attachments` e os demais nomes de `RESERVED_PROCESS_NAMES` (`src/domain/ids.ts`) não valem como nome de processo; `create_process` os recusa com `RESERVED_NAME`.
- O código de `domain/`, `commands/`, `queries/` e `mcp/` não contém termo de fluxo nem de framework; `test/no-flow-terms.spec.ts` trava ([ADR 0007](adr-0007-dominio.md), item 3).

## Validação do register

- O `INVALID_RECORD` de dado junta as violações de schema de todos os registros do lote (`src/commands/register/static.ts#prepareBatch`), com `path` `/records/<i>/data/...` e o teto de `capDetails` (50 e `too-many-errors`); continua tudo-ou-nada.
- O `register` confere o tipo fixado de todos os registros antes de validar dado (`src/commands/register/static.ts#prepareBatch`): `TYPE_NOT_PINNED` vence o `INVALID_RECORD` de dado.
- O relatório (`Validator.report`, em `src/adapters/validator.ts#createValidator`) só roda depois de o `validate` falhar, sobre o schema intacto, com compilado em cache por identidade do schema; o `validate` nunca usa `allErrors`.
- O relatório usa o motor `src/adapters/validator.ts#boundedRegExp`, que só roda regex em texto de até `PATTERN_MAX_LENGTH` pontos de código; o `maxLength` não protege o relatório sob `allErrors`, e o risco residual é aceito ([tetos-dominio-v1.md](../tetos-dominio-v1.md), "Limites do relatório").
- O relatório mantém `format` ativo, fora do motor, e a guarda de tempo de `test/adapters/validator.budget.spec.ts` trava o custo em string de `DATA_MAX_CHARS`.
- O motor do relatório declara `code = 'boundedRegExp'` (`src/adapters/validator.ts#boundedRegExp`) para que uma geração standalone do ajv falhe alto, em vez de perder o teto de 256 pontos de código sem aviso.

## Anexos

- Anexo é um blob imutável em `<projeto>/attachments/<sha256>`. Nunca crie código que escreva por cima de um blob existente: a gravação é por `link` exclusivo, e `EEXIST` relê e compara o hash (`src/adapters/fs/attachment-store.ts`), com teto `ATTACHMENT_MAX_BYTES`.
- `verify_chain` e `read_attachment` re-hasheiam o blob sempre; `shared/loader.ts#loadVerified` não faz I/O de anexo ([ADR 0009](adr-0009-ferramental.md), item 21).
- O campo de anexo é marcado no schema por `format: "attachment"`, e o `register` recusa hash de anexo em campo sem a marca ([ADR 0007](adr-0007-dominio.md), itens 11 a 13).
- A tool `attach` aceita `text` ou `path` de um arquivo `.md`/`.txt` dentro do `cwd` do servidor e fora de `<D>` ([ADR 0009](adr-0009-ferramental.md), itens 1 e 14). O `cwd` é o teto (sessão em `$HOME` alcança todo `.md`/`.txt`), e só essas extensões entram por não carregarem credencial (`.json`, `.log`, `.env` ficam fora). Não amplie esse alcance sem um ADR novo.

## Definições

- `define_type`, `define_relation` e `define_gate` versionam em semver `major.minor` em `<nome>/<versão>.json`, nunca sobrescrevem e não deixam arquivo legado. `adapters/fs/definition-store.ts` escreve cada versão por `link` exclusivo, nunca por `rename`.
- Mudança que quebra exige `breaking: true` (`BREAKING_CHANGE`); o processo fixa as versões vigentes na criação (`create_process`) e, depois de uma quebra, o caminho é um processo novo ([ADR 0007](adr-0007-dominio.md), itens 15 a 17).
