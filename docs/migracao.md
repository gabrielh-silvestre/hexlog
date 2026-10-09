# Migração do 0.x

Arquivamento do dado 0.x e migração para a 1.0. O resumo da instalação está no [README](../README.md).

## Dado 0.x: arquivamento (`--archive-0x`)

A 1.0 não lê nem migra o dado do 0.x: ela só enxerga `<D>/.v1/`. O 0.x grava
projetos direto em `<D>`, e a detecção é positiva: qualquer entrada de `<D>` com
nome de projeto 0.x (minúsculas, dígitos e hífen, exceto `archive`) conta como
dado 0.x. Com dado 0.x em `<D>`, o servidor recusa toda tool com `LEGACY_DATA`
(o `details` traz o comando de arquivamento) e os scripts de leitura saem com 2.
O arquivador é só Linux: acha servidor 0.x vivo por `/proc` (macOS não foi testado).
Nos comandos desta seção, o diretório de dados é
`D=${XDG_DATA_HOME:-$HOME/.local/share}/hexlog`.

Para arquivar:

```sh
node scripts/install.ts                # lista o que seria arquivado e sai 2, sem alterar nada
node scripts/install.ts --archive-0x   # arquiva e segue para a instalação
node scripts/install.ts --check
```

O `--archive-0x` gera `<D>/archive/hexlog-0x-<data>.tar` com todos os arquivos
regulares do 0.x, relê o pacote e confere caminho e sha256 contra a lista, relê e
re-hasheia os originais e só então remove o que listou (arquivos e depois
diretórios vazios, sem recursão). Qualquer divergência aborta com exit 1, sem
instalar e sem apagar nada que não esteja no `.tar` verificado.

- **Recusas:** servidor 0.x vivo (processo com `server.mjs` de uma versão 0.x em
  `~/.local/lib/hexlog/`), `/proc` ilegível ou `cmdline` ilegível por motivo que não
  seja permissão ou processo que sumiu (não dá para confirmar que nenhum servidor
  roda), lock 0.x com dono vivo ou com `holder` fora do formato `<pid>-<hex>` (um
  `holder` ausente ou de 0 byte conta como lock morto), e symlink, hard link ou
  arquivo especial no dado 0.x. Feche as sessões do Claude Code antes. Com todas
  fechadas e a recusa de lock mantida (pid reaproveitado, `holder` ilegível),
  remova à mão a pasta `events.jsonl.lock/` que a mensagem cita e rode de novo.
- **Retomada:** se a execução cair depois de gerar o `.tar`, rodar de novo reusa o
  `.tar` mais novo que contém todo arquivo restante com o mesmo sha256, em vez de
  gerar outro.
- **Instalação que falha depois do arquivamento:** o dado já está no `.tar`. Se a
  remoção de `<D>` terminou, rode `node scripts/install.ts` de novo, sem a flag, e a
  instalação conclui. Se o arquivamento caiu antes de remover tudo, sem a flag o
  instalador só lista (exit 2): rode com `--archive-0x`, que reaproveita o `.tar`.
- **Um ou vários `.tar`:** uma execução com arquivo novo no 0.x gera outro `.tar`
  em vez de reescrever o anterior, então `<D>/archive/` pode ter mais de um. O
  nome tem resolução de segundo: dois arquivamentos no mesmo segundo que precisem
  de pacote novo sobrescrevem o anterior (teto aceito no ADR 0009).
- **Cópia manual antes:** `cp -a "$D" ~/hexlog-0x-backup-$(date +%F)`.
  Ensaie primeiro numa cópia (`XDG_DATA_HOME` e `HOME` apontando para um diretório
  temporário), e confira o pacote só pelos arquivos regulares, porque o `tar` pode
  gravar ou não as entradas de diretório.

Depois do arquivamento, a trilha 0.x de todo projeto só existe nos `.tar`.

### Reler a trilha 0.x arquivada

Sem passo novo na instalação: extraia os `.tar` numa pasta descartável e suba um
servidor 0.x só para ela, com o seu `XDG_DATA_HOME`.

```sh
D=${XDG_DATA_HOME:-$HOME/.local/share}/hexlog
R=$(mktemp -d); mkdir -p "$R/hexlog" "$R/src"
for t in $(ls -tr "$D"/archive/hexlog-0x-*.tar); do tar -xf "$t" -C "$R/hexlog"; done
git archive 87237c3 | tar -x -C "$R/src"        # ou v0.4.0, o atalho para o mesmo código
(cd "$R/src" && npm ci && node scripts/build.ts --outdir "$R/bin")
```

Aponte um `$R/mcp.json` para o bundle e para a pasta extraída:

```json
{"mcpServers":{"hexlog":{"command":"node","args":["<R>/bin/server.mjs"],"env":{"XDG_DATA_HOME":"<R>"}}}}
```

e rode `claude -p "<pedido>" --mcp-config "$R/mcp.json" --strict-mcp-config`. Os
`.tar` entram do mais velho para o mais novo (o `ls -tr` ordena pela data de
modificação), porque o mais novo sobrescreve o mais velho; `tar -xf a.tar b.tar`
trataria o segundo como nome de membro, por isso o laço. O `<D>` real não é tocado.

### Voltar ao 0.x

Se algo falhar depois do arquivamento:

1. Feche as sessões do Claude Code e defina `D=${XDG_DATA_HOME:-$HOME/.local/share}/hexlog`.
2. Tire o dado 1.0 do caminho, para não se misturar: `mv "$D/.v1" ~/hexlog-1x-aside-$(date +%F)`.
3. Restaure o 0.x, cada `.tar` do mais velho para o mais novo (ou use a cópia manual):
   `for t in $(ls -tr "$D"/archive/hexlog-0x-*.tar); do tar -xf "$t" -C "$D"; done`.
   O `tar -x` devolve os diretórios de projeto com modo 0755 (o 0.x criava 0700), então
   rode `chmod -R go-rwx "$D"`, e não recria diretório 0.x vazio
   (o `.tar` guarda só arquivos regulares).
4. Tire `archive/` do caminho, porque o 0.x o listaria como um projeto vazio:
   `mv "$D/archive" ~/hexlog-archive-aside-$(date +%F)`.
5. Reinstale o 0.x: `git checkout 87237c3 && npm ci && node scripts/install.ts`
   (ou `v0.4.0`, o atalho para o mesmo código) e reinicie o Claude Code.

## Migração 0.x para 1.0

A 1.0 é uma quebra: modelo de dados, formato em disco e tools mudam, e o dado 0.x
não é migrado, é arquivado (seção acima). Reinstale servidor e skills juntos
(`node scripts/install.ts`) e reinicie as sessões abertas: servidor antigo em
memória com skills novas responde `Input validation error`.

- O 0.x guardava Marcos e Vereditos com `supersedes` no evento. A 1.0 guarda
  **registros** de um tipo definido por `define_type`, ligados por **relações**
  (`supersedes`, `revokes`, `supports` e outras) e avaliados por **gates
  declarativos**. Não há vocabulário, `Estado` nem `state`.
- `evaluate_gate` não grava mais Marco: só calcula e devolve.
- Cada tool 0.x tem um destino:

| 0.x | 1.0 |
|---|---|
| `list` | `list` |
| `register_type` | `define_type` |
| `register_vocabulary` | sem equivalente (o vocabulário saiu) |
| `register_gate` | `define_gate` (gate vira uma lista de perguntas) |
| (novo) | `define_relation` |
| `create_process` | `create_process` |
| `register` | `register` (lote de 1 a 50 registros, atômico) |
| `evaluate_gate` | `evaluate_gate` (só leitura) |
| `state`, `events` | `query` |
| `timeline` | `query` com `scope: "project"`, e `scripts/timeline.ts` para texto grande |
| `chain` | `verify_chain` |
| `attachment` | `attach` e `read_attachment` |

- Os scripts de leitura mudaram de contrato (ver [Scripts de leitura](desenvolvimento.md#scripts-de-leitura)): `export`
  emite campos de `QueryRecord`, e `timeline` recebe prefixo de target.
- Backup de processo com anexos: copie o diretório do projeto em `<D>/.v1/`, não só
  o JSONL; `scripts/export.ts` não leva `process.json`, as definições nem
  `attachments/`.
