# Anexos: `path`, recusas e anexo sem marca

Detalhe do `attach` e do campo de anexo. A ordem das chamadas (`attach`, depois `register` com o `hash`), a idempotência e os erros `ATTACHMENT_NOT_FOUND` e `ATTACHMENT_CORRUPTED` estão no `SKILL.md`, seção "Anexos". Carregue este arquivo ao montar um `path` ou ao receber `INVALID_INPUT` do `attach` ou `unmarked-attachment` do `register`.

## Anexar por `path`

O arquivo `.md` ou `.txt` que já existe no repositório (plano, spec, relatório gravado em disco) se anexa por `path`, sem reescrever o texto: o blob é cópia exata e o conteúdo passa direto, sem o modelo. O `path` é relativo ao diretório de trabalho do servidor (ou absoluto), fica dentro dele e fora de `<D>`, termina em `.md` ou `.txt` (minúsculo) e é arquivo regular, sem symlink, de até 1 MiB e UTF-8 válido.

A recusa é `INVALID_INPUT` com `details[0].code`:

| `code` | Quando |
|---|---|
| `outside-allowed-root` | O `path` fica fora do diretório de trabalho (também quando o diretório do `path` não resolve) |
| `inside-data-dir` | O `path` cai dentro de `<D>` |
| `bad-extension` | A extensão é diferente de `.md` e `.txt` minúsculos |
| `not-regular` | Symlink ou hardlink |
| `not-found` | O arquivo é inexistente |
| `too-big` | Acima de 1 MiB |
| `invalid-utf8` | Os bytes são UTF-8 inválido |
| `bad-args` | Argumentos inválidos (inclui arquivo vazio) |

Com `outside-allowed-root`, copie o arquivo com cp (cópia exata, o texto fica como está) para dentro do diretório do servidor e anexe a cópia.

## Anexar por `text`

O texto que não existe em arquivo (relatório que um agente devolveu) vai por `text`, colado como veio, sem resumir, cortar nem reformatar. `text` e `path` são alternativos: passe um dos dois. O `text` é recusado em `/text` quando vazio (`bad-args`), com surrogate solto (`lone-surrogate`) ou acima de 1 MiB em bytes UTF-8 (`too-big`).

## Anexo sem marca: `unmarked-attachment`

O `register` recusa com `INVALID_RECORD` e `details[0].code` `unmarked-attachment` o campo sem `format: "attachment"` cujo valor é o hash de um anexo existente (`details[0].path` = `/records/<i>/data/<campo>`; o lote fica sem gravar). O processo fixou o tipo sem a marca e é imutável: `create_process` não refixa, então esse campo recusa esse hash para sempre. Duas saídas, nesta ordem de preferência:

1. **Citar o hash por outro tipo já fixado no processo que tenha a marca.** É a saída quando a linhagem (`supersedes`/`revokes`) precisa continuar, porque essas relações ficam dentro do processo. Só existe quando o campo sem marca é **opcional** na versão fixada do tipo: o sucessor (mesmo tipo) **omite o campo**, e um registro do tipo marcado guarda o hash. O sucessor se liga a esse registro por `derivesFrom` ou `complements`, com o registro do tipo marcado antes dele no mesmo lote (`@alias`). Os tipos do exemplo são hipotéticos: `plan-legacy` (fixado com o campo `file` sem marca, opcional) e `evidence-file` (marcado, com o campo `file`):

   ```text
   records: [
     { alias: "file", type: "evidence-file", target: "x.y", data: { file: "<hash>" } },
     { type: "plan-legacy", target: "x.y", data: { isRevision: true, diff: "…" },
       relations: [ { to: "<id do plan-legacy vigente>", kind: "supersedes" },
                    { to: "@file", kind: "derivesFrom" } ] }
   ]
   ```

2. **Processo novo**, fixando a versão marcada do tipo (definida com `breaking: true`, porque acrescentar `format` é quebra). É a saída quando nenhum tipo marcado está fixado no processo, ou quando o campo é `required` na versão fixada (o sucessor teria de preencher o campo, e o único valor verdadeiro é o hash que a guarda recusa). O processo novo **deixa os registros do antigo como estão** (sem `supersedes` nem `revokes` sobre eles): a linhagem fica presa no processo velho.
