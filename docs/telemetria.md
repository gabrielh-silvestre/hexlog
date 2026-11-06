# Telemetria

O servidor pode mandar um span por chamada de tool e três métricas a um backend
OpenTelemetry local, por OTLP/HTTP. Serve para ranquear o uso das tools, medir erro
por `code` e achar a chamada lenta. É opcional e vem desligada: sem
`HEXLOG_OTEL_ENDPOINT` o servidor não abre conexão, não instala handler de processo e
as tools respondem como antes. O SDK do OpenTelemetry é importado de forma estática:
ele carrega em todo boot, ligada ou não, e em cada script do fonte que importa
`compose.ts`. Medido em 2026-11-05: cerca de 230 KB a mais no bundle, cerca de 12 ms no
boot do bundle e cerca de 0,14 s no script do fonte. A medição, a decisão e os limites
aceitos estão no [ADR 0015](directives/adr-0015-telemetria-opentelemetry.md).

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

Nenhuma variável `OTEL_*` liga nem configura a telemetria do hexlog. Outros clientes MCP,
o `env` da entrada e o shell podem trazer `OTEL_*`, e o SDK do OpenTelemetry as lê por
baixo da configuração explícita (cabeçalhos e compressão), então o servidor constrói os
exporters com todas as `OTEL_*` fora de `process.env` e com `url`, cabeçalhos e
temporalidade cumulativa explícitos. A compressão e o prazo de envio também não vêm do
ambiente. O Claude Code não repassa `OTEL_*` aos subprocessos que ele sobe, servidores MCP
incluídos (documentação oficial de monitoramento do Claude Code).

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
`http:` ou `https:`, ou leva usuário, senha, query ou fragmento) ou `sdk-init-failed` (o SDK falhou ao subir), nunca a mensagem da exceção.

## Encerramento

Com a telemetria ligada, o servidor entrega o que está em fila antes de sair. Gatilhos: o
fim do stdin (o cliente fechou), `beforeExit`, `SIGTERM` (saída 143) e `SIGINT` (130).
O primeiro gatilho decide o orçamento. Um sinal recebido com o encerramento já em curso não
sai na hora: espera esse mesmo encerramento e sai com o código do sinal.

O orçamento do fim do stdin é de 1.750 ms no pior caso: 250 ms para fechar o transporte e
1.500 ms de `shutdown` da telemetria, dentro dos quais as chamadas em voo esperam até
500 ms. Sai antes do `SIGTERM` que um cliente que fecha o stdin manda 2.000 ms depois. O
`shutdown` dos provedores faz o envio final; não há `forceFlush` à parte.

O orçamento do caminho de sinal é de 350 ms: 100 ms para fechar o transporte e 250 ms de
`shutdown` da telemetria. O Claude Code 2.1.318 no Linux não fecha o stdin: manda `SIGINT`,
`SIGTERM` 100 ms depois e `SIGKILL` aos 500 ms, então o envio final precisa terminar antes
disso. Se o fim do stdin decidiu o orçamento de 1.750 ms e um sinal chega depois, o
`SIGKILL` do cliente corta a espera.

Consequência: uma tool que ainda roda depois do fim do stdin pode não terminar de gravar
(300 ms grava, 800 ms não), porque o processo sai ao fim do orçamento. A escrita do log é
síncrona, e o lock que ficar órfão é roubado por pid. Com a telemetria desligada o
processo sai quando o transporte fecha, e a resposta da tool em voo também se perde.

## Riscos residuais

- **Lote final perdido com backend lento.** O prazo de envio (3.000 ms) é maior que o que
  sobra do orçamento do fim do stdin (a partir de 1.000 ms) e que os 250 ms do caminho de
  sinal: se o backend responde devagar (a partir de ~250 ms sob `SIGINT` ou `SIGTERM`), o
  último lote pode não sair, e uma sessão curta pode não enviar nada.
- **Timer atrasado por trabalho síncrono.** Contar as linhas de um log grande ocupa o
  laço de eventos: de 6 a 15 ms por processo de 64 MiB, medidos em 2026-11-05
  ([ADR 0015](directives/adr-0015-telemetria-opentelemetry.md)). Numa consulta de projeto o custo
  soma por processo, e um envio agendado pode atrasar esse tempo.
- **Reenvio de métricas ocioso.** Depois da primeira chamada, cada servidor ocioso reenvia
  o mesmo ponto cumulativo a cada 15 s: cerca de 240 envios por hora por processo, uma
  linha por envio e por série. Agregue com `max(value)` por série e por instância
  (`service_instance_id`) e some as instâncias, como nas consultas do exemplo abaixo.
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
- Só o `fetch` do probe segue `HTTP_PROXY` e `HTTPS_PROXY`, e só com `NODE_USE_ENV_PROXY=1` no ambiente do servidor. O exporter OTLP conecta direto ao destino, sem proxy. Atrás de um proxy obrigatório o probe e o envio podem divergir, então `telemetry-degraded` com motivo `probe` não prova que o envio falha.
- Uma URL com usuário ou senha em `HEXLOG_OTEL_ENDPOINT` é recusada como `invalid-endpoint`: a credencial vai em `HEXLOG_OTEL_HEADERS`. Query (`?org=acme`) e fragmento (`#x`) também são recusados, porque o servidor acrescenta `/v1/traces` ao fim da base e o resultado cairia no lugar errado.

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
  uma linha por envio, e cada sessão do Claude Code sobe um servidor próprio com a mesma
  série. Cada servidor leva um `service.instance.id` novo por boot, que vira a coluna
  `service_instance_id` (o mapeamento no OpenObserve ainda não foi conferido numa sessão
  real). Agregue com `max(value)` por série e por instância e depois com `sum` entre as
  instâncias; `max(value)` direto, sem a instância, devolve só a maior e subconta as
  chamadas de quem tem mais de um servidor.

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
select hexlog_tool, sum(calls) as calls from (
  select hexlog_tool, service_instance_id, max(value) as calls from "hexlog_tool_calls"
  group by hexlog_tool, service_instance_id)
group by hexlog_tool order by calls desc

select hexlog_tool, hexlog_error_code, sum(n) as n from (
  select hexlog_tool, hexlog_error_code, service_instance_id, max(value) as n from "hexlog_tool_errors"
  group by hexlog_tool, hexlog_error_code, service_instance_id)
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
