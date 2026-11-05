# Telemetria

O servidor pode mandar um span por chamada de tool e três métricas a um backend
OpenTelemetry local, por OTLP/HTTP. Serve para ranquear o uso das tools, medir erro
por `code` e achar a chamada lenta. É opcional e vem desligada: sem
`HEXLOG_OTEL_ENDPOINT` o servidor não abre conexão, não instala handler de processo e
se comporta como antes. A decisão e os limites aceitos estão no
[ADR 0015](directives/adr-0015-telemetria-opentelemetry.md).

- [Variáveis](#variáveis)
- [O que o span e as métricas levam](#o-que-o-span-e-as-métricas-levam)
- [Aviso `telemetry-degraded` e estado de envio](#aviso-telemetry-degraded-e-estado-de-envio)
- [Encerramento](#encerramento)
- [Riscos residuais](#riscos-residuais)
- [Privacidade](#privacidade)
- [Exemplo com OpenObserve](#exemplo-com-openobserve)
- [Como editar o `env` da entrada MCP](#como-editar-o-env-da-entrada-mcp)
- [Collector local (opcional)](#collector-local-opcional)
- [Desenvolvimento](#desenvolvimento)

## Variáveis

| Variável | Efeito |
|---|---|
| `HEXLOG_OTEL_ENDPOINT` | Liga a telemetria. É a base do OTLP/HTTP, sem `/v1/...`: o servidor acrescenta `/v1/traces` e `/v1/metrics` (a barra final é removida). Ausente ou vazia, a telemetria fica desligada. |
| `HEXLOG_OTEL_HEADERS` | Cabeçalhos dos envios, pares `chave=valor` separados por vírgula. O valor é dividido no primeiro `=` e chave e valor são decodificados como URL: um espaço vira `%20`, por exemplo `Authorization=Basic%20<base64>`. Par malformado, nome que não é token HTTP ou valor com CR, LF ou NUL é ignorado. |

Nenhuma variável `OTEL_*` liga nem configura a telemetria do hexlog. O Claude Code usa
`OTEL_EXPORTER_OTLP_ENDPOINT` para a própria telemetria e os processos MCP a herdam, então
o servidor constrói os exporters com todas as `OTEL_*` fora de `process.env` e com
`url`, cabeçalhos e temporalidade cumulativa explícitos. A compressão e o prazo de envio
também não vêm do ambiente.

## O que o span e as métricas levam

Um span `tool <nome>` por chamada, fechado quando a resposta fica pronta.

| Atributo do span | Quando aparece |
|---|---|
| `hexlog.tool` | Sempre. |
| `hexlog.process.count` | Sempre, inteiro maior ou igual a 0: quantos processos a chamada leu ou escreveu. |
| `hexlog.project` | Com processo alvo, ou quando todos os processos lidos são do mesmo projeto. |
| `hexlog.process` | Com processo alvo, ou quando a chamada leu um único processo: um `list` ou uma consulta de projeto sem alvo, num projeto com um só processo, leva o `hexlog.process` dele. Com 2 ou mais processos lidos e sem alvo, fica ausente. |
| `hexlog.log.lines` | Nº de linhas do `records.jsonl` do alvo antes da escrita; sem alvo, a soma dos processos que reportaram. |
| `hexlog.log.bytes` | Tamanho em bytes do mesmo log, com a mesma regra. |
| `hexlog.error.code` | Só em erro: o `code` do erro de topo. |
| `hexlog.error.detail_codes` | Só em erro com `details`: array dos códigos distintos de `details[].code`, até 20. |
| `hexlog.error.detail_codes_omitted` | Só quando passou de 20: quantos códigos ficaram de fora. |

Em erro, o span fica com estado `ERROR` sem mensagem e sem exceção registrada.

Três métricas, só com rótulos enumerados:

| Métrica | Tipo | Rótulos |
|---|---|---|
| `hexlog.tool.calls` | contador | `hexlog.tool` |
| `hexlog.tool.errors` | contador | `hexlog.tool`, `hexlog.error.code` |
| `hexlog.tool.duration` | histograma em `ms`, limites 1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500 e 5000 | `hexlog.tool` |

O recurso leva `service.name` = `hexlog` e `service.version`. As métricas não levam
`project`, `process`, `details` nem `message`.

Observações sobre os tamanhos:

- O tamanho vem do que o armazenamento já mediu ao ler o log, sem interpretar registros:
  a contagem é de linhas, não de registros. Um log sem `\n` final conta uma linha a menos.
- `create_process`, `describe_type` e `list` só leem manifestos ou definições, então
  saem sem `hexlog.log.lines` nem `hexlog.log.bytes`.
- Os valores são os de antes da escrita: num `register`, o tamanho do log antes do lote.
- Uma consulta que lê um processo recusado por `PROCESS_TOO_LARGE` leva o processo e os
  bytes, e as linhas só quando a leitura chegou a contá-las.

## Aviso `telemetry-degraded` e estado de envio

Com a telemetria ligada, o servidor faz no boot um `HEAD` no endpoint, com prazo de
1.000 ms, sem segurar a subida. Qualquer resposta HTTP conta como alcançável, 404 e 405
inclusive (o Collector responde 405 ao `HEAD` em `/v1/traces`). Erro de conexão ou prazo
vencido conta como falha.

Enquanto o probe ou o último envio falhou, cada chamada de tool escreve no stderr o log
`telemetry-degraded`, que diz só se a falha é do probe ou do envio (`reason` `probe` ou
`export`), nunca o endpoint nem a mensagem de uma exceção. O aviso não espera rede e a resposta da tool não
muda por causa dele.

- **Estado de envio.** É o resultado do último envio de qualquer sinal: os traces saem a
  cada 5 s e as métricas a cada 15 s. Um envio que falha liga o aviso; o seguinte que dá
  certo o desliga.
- **Probe pendente.** Chamada feita antes de o probe terminar não escreve o aviso. O prazo
  de 1.000 ms é o limite dessa janela: passado ele, o probe conta como falho e o aviso
  começa.
- **401 e 403.** O `HEAD` já é uma resposta HTTP, então o probe passa. O aviso só aparece
  depois do primeiro lote de envio, que pode levar até 5 s.
- **Sinal mascarado.** Se só um dos sinais falha, o sucesso do outro desliga o aviso.
- **Atraso na volta.** Um resultado tardio de um envio antigo pode reacender o aviso por
  até um lote.
- **Prazo por envio.** Cada exporter tem prazo próprio de 3.000 ms por envio, que cobre
  também a conexão; vencido o prazo, o envio conta como falho.

Se a construção do adaptador falha (URL inválida, por exemplo), o servidor volta à
telemetria desligada e escreve uma vez `telemetry-init-failed` com o `reason` `invalid-endpoint` (o endpoint não é uma URL
`http:` ou `https:`) ou `sdk-init-failed` (o SDK falhou ao subir), nunca a mensagem da exceção.

## Encerramento

Com a telemetria ligada, o servidor entrega o que está em fila antes de sair. Gatilhos: o
fim do stdin (o cliente fechou), `beforeExit`, `SIGTERM` (saída 143) e `SIGINT` (130).
Um sinal recebido com o encerramento já em curso sai na hora.

O orçamento do fim do stdin é de 1.750 ms no pior caso: 250 ms para fechar o transporte e
1.500 ms de `shutdown` da telemetria, dentro dos quais as chamadas em voo esperam até
500 ms. Sai antes do `SIGTERM` que o cliente de referência manda 2.000 ms depois do fim
do stdin. O `shutdown` dos provedores faz o envio final; não há `forceFlush` à parte.

Consequência: uma tool que ainda roda depois do fim do stdin pode não terminar de gravar
(300 ms grava, 800 ms não), porque o processo sai ao fim do orçamento. A escrita do log é
síncrona, e o lock que ficar órfão é roubado por pid. Com a telemetria desligada o
processo sai quando o transporte fecha, e a resposta da tool em voo também se perde.

## Riscos residuais

- **Lote final perdido com backend lento.** O prazo de envio (3.000 ms) é maior que o que
  sobra do orçamento do fim do stdin (a partir de 1.000 ms): se o backend responde
  devagar, o último lote pode não sair.
- **Timer atrasado por trabalho síncrono.** Contar as linhas de um log grande ocupa o
  laço de eventos: de 6 a 15 ms por processo de 64 MiB. Numa consulta de projeto o custo
  soma por processo, e um envio agendado pode atrasar esse tempo.
- **`kill -9`.** Não há como entregar o que estava em fila.
- **Estado de envio atrasado.** Descrito acima: uma falha de um só sinal pode ficar
  mascarada, e o aviso pode reaparecer por um lote.
- **Segredo no `~/.claude.json`.** Ver [Como editar o `env` da entrada MCP](#como-editar-o-env-da-entrada-mcp).

## Privacidade

O destino deve ser um backend local ou de confiança: o servidor não confere o host.

- Só o span leva `project` e `process` em claro. O log `tool`, `tool-over-cap`, os
  avisos `telemetry-*` e as métricas não os levam.
- O conteúdo da entrada, o `path` e a `message` (do erro e de `details`) não vão ao span
  nem a nenhuma dessas superfícies. De `details` só vai o `code` de cada item.
- Nenhum dado do registro, do anexo ou do manifesto sai do servidor.

- Um endpoint `http:` fora de loopback manda o valor de `HEXLOG_OTEL_HEADERS` em claro pela rede: use loopback ou `https:`.
- O `claude mcp add -e K=V` que o instalador roda deixa o valor de `HEXLOG_OTEL_HEADERS` no argv, visível em `/proc/<pid>/cmdline` e no `ps` enquanto o comando roda. Risco aceito. Se o comando falha, o instalador não repete o argv na mensagem de erro.
- O `fetch` do probe e o exporter só seguem `HTTP_PROXY` e `HTTPS_PROXY` com `NODE_USE_ENV_PROXY=1` no ambiente do servidor. Esse caminho não foi testado.
- Uma URL com usuário ou senha em `HEXLOG_OTEL_ENDPOINT` é recusada como `invalid-endpoint`: a credencial vai em `HEXLOG_OTEL_HEADERS`.

A regra completa é `telemetry-surfaces`, em [invariantes.md](directives/invariantes.md).

## Exemplo com OpenObserve

Valores conferidos contra o OpenObserve v1.1.2 rodando em Docker local, com o
`default` como organização:

```sh
HEXLOG_OTEL_ENDPOINT=http://localhost:5080/api/default
HEXLOG_OTEL_HEADERS=Authorization=Basic%20<base64 de usuario:senha>
```

O OpenObserve aceita OTLP/HTTP em JSON com Basic auth (resposta 200) e recusa a chamada
sem o cabeçalho (401). Particularidades do armazenamento:

- Os atributos viram colunas com o `.` trocado por `_` (`hexlog.tool` vira `hexlog_tool`).
- `hexlog.error.detail_codes` chega como uma string JSON (`["A","B"]`), não como colunas.
  A consulta por elemento precisa abrir a string.
- Os atributos numéricos do span (`hexlog_process_count`, `hexlog_log_lines`,
  `hexlog_log_bytes`) chegam como string: use `cast(... as bigint)` para somar ou comparar.
- Cada métrica é um stream. O histograma vira cinco: `_bucket` (com a coluna `le`),
  `_count`, `_sum`, `_min` e `_max`.
- Os contadores e o histograma são cumulativos e reexportados a cada intervalo, o que gera
  uma linha por envio: agregue com `max(value)` por série, nunca com `sum`.

Consultas nos traces (stream `default`, tipo `traces`):

```sql
-- ranking de tools
select hexlog_tool, count(*) as calls from "default"
group by hexlog_tool order by calls desc

-- taxa de erro por tool
select hexlog_tool, count(*) as calls,
  round(100.0 * sum(case when hexlog_error_code is not null then 1 else 0 end) / count(*), 1) as error_pct
from "default" group by hexlog_tool order by calls desc

-- erros por tool e code
select hexlog_tool, hexlog_error_code, count(*) as n from "default"
where hexlog_error_code is not null group by hexlog_tool, hexlog_error_code order by n desc

-- detail_codes por elemento do array
select hexlog_tool, code, count(*) as n from (
  select hexlog_tool,
    unnest(string_to_array(regexp_replace(hexlog_error_detail_codes, '[\[\]"]', '', 'g'), ',')) as code
  from "default" where hexlog_error_detail_codes is not null)
group by hexlog_tool, code order by n desc

-- tamanho do log por processo
select hexlog_process, max(cast(hexlog_log_bytes as bigint)) as bytes,
  max(cast(hexlog_log_lines as bigint)) as lines
from "default" where hexlog_process is not null group by hexlog_process
```

Consultas nas métricas (tipo `metrics`):

```sql
select hexlog_tool, max(value) as calls from "hexlog_tool_calls" group by hexlog_tool order by calls desc
select hexlog_tool, hexlog_error_code, max(value) as n from "hexlog_tool_errors"
group by hexlog_tool, hexlog_error_code order by n desc
```

## Como editar o `env` da entrada MCP

A telemetria é ligada pelo `env` da entrada `hexlog` em `mcpServers` do `~/.claude.json`.
Duas formas:

1. Pelo CLI do Claude Code. O `remove` é obrigatório, porque o `add` falha se a entrada
   existe, e os `-e` vêm antes do `--`:

   ```sh
   claude mcp remove hexlog -s user
   claude mcp add --scope user hexlog \
     -e HEXLOG_OTEL_ENDPOINT=http://localhost:5080/api/default \
     -e HEXLOG_OTEL_HEADERS=Authorization=Basic%20<base64> \
     -- <caminho do node> <caminho do server.mjs instalado>
   ```

   O CLI divide cada `-e` no primeiro `=`, então um valor com `=` passa intacto. Os
   caminhos de `node` e do servidor são os que `claude mcp get hexlog` mostra hoje.

2. Editando o campo `env` da entrada `hexlog` no `~/.claude.json` à mão.

Reinicie o Claude Code depois: o servidor lê o ambiente no boot.

**O que o instalador preserva.** `node scripts/install.ts` refaz a entrada `hexlog` e preserva o `env` dela (só valores string), repassando cada
par a `claude mcp add -e`. A saída lista só os nomes (`mcp env preserved: <chaves>`),
nunca os valores. Para desligar a telemetria, remova as duas chaves do `env` pelo mesmo
caminho: o instalador não as recria.

**Aviso de segredo.** O `claude mcp get hexlog` imprime o `env` em claro, e o
`~/.claude.json` o guarda em texto. Um segredo em `HEXLOG_OTEL_HEADERS` fica legível nos
dois. Prefira um backend local e uma credencial só desse uso, ou o Collector local
abaixo, que tira a credencial do backend desse arquivo.

## Collector local (opcional)

Fica fora desta implementação, anotado como opção (follow-up do
[ADR 0015](directives/adr-0015-telemetria-opentelemetry.md)). A ideia é mandar o hexlog
para um Collector do OpenTelemetry em `localhost`, que faz lote, retry e fila em disco e
fala com o backend. Isso reduz a perda de telemetria no encerramento do processo e deixa
a credencial do backend no arquivo do Collector, não no `~/.claude.json`. O custo é um
processo e um arquivo de configuração que você mantém: subir, atualizar a versão.

O exemplo abaixo usa a distribuição `otelcol-contrib`, que traz a extensão
`file_storage`. Não foi ensaiado contra um Collector real:

```yaml
extensions:
  file_storage:
    directory: /var/lib/otelcol/queue

receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318

exporters:
  otlphttp/openobserve:
    endpoint: http://localhost:5080/api/default
    headers:
      Authorization: "Basic <base64 de usuario:senha>"
    retry_on_failure:
      enabled: true
    sending_queue:
      enabled: true
      storage: file_storage

service:
  extensions: [file_storage]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/openobserve]
    metrics:
      receivers: [otlp]
      exporters: [otlphttp/openobserve]
```

No hexlog, a chave passa a apontar para o Collector e dispensa os cabeçalhos:

```sh
HEXLOG_OTEL_ENDPOINT=http://127.0.0.1:4318
```

## Desenvolvimento

O exporter OTLP real não envia dentro do jest: o jest roda em CJS e recusa o `import()` do
módulo de rede que o exporter carrega. Por isso os testes unitários usam exporters de
captura, e o envio pela rede é provado por processo filho, em `test/fixtures/otel-sender.ts`
e no teste e2e do servidor empacotado (`test/stdio.e2e.spec.ts`).
