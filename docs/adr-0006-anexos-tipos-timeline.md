# ADR 0006: Anexos, tipos de auditoria e timeline

**Status:** Aceito

**Data:** 2026-09-29

**Deciders:** Gabriel Henrique Silvestre Baldino; planejamento RALPLAN "trilha de auditoria hexlog" (consenso na iteração 5)

---

## Context

Os quatro processos do piloto (`omc-discover`, `omc-plan`, `omc-exec`, `omc-verify`) registram marcos e vereditos de um fluxo OMC autônomo, mas não deixam um humano auditar a execução depois: falta o porquê das decisões do planner, do architect e do critic (inclusive as iterações rejeitadas e o diff entre elas), falta todo desvio do caminho feliz na execução (sintoma, causa, tentativas, alternativas, desfecho), falta o texto integral do que o agente entregou e falta uma visão por target que cruze os processos e diga se a cadeia e os anexos estão íntegros.

Achados do código que moldaram a decisão:

- Tipo custom é inerte para `state` e gates (`targetOf` devolve `undefined`; a supersessão só olha Veredito), e o filtro `target` de `events` lê `data.target` cru, de qualquer tipo. Um tipo custom com `target` obrigatório entra na busca por `events` sem tocar em nenhum dos dois.
- O teto de `data` (16.000 caracteres canônicos) vale para tipo custom; o texto de um relatório de agente ou de um plano (de 7 KB a 240 KB) não cabe no evento.
- Uma tool devolve o resultado duas vezes (`structuredContent` e o texto) e a página de saída tem teto de 24.000 caracteres: texto grande precisa de paginação e de um canal barato de entrada.
- `scripts/export.ts` exporta só as linhas de evento; não leva `process.json` (a âncora da cadeia) nem blobs, então o JSONL sozinho não restaura um processo.
- Tipo custom não tem validação de `supersedes`; só o Veredito tem.

## Decision

1. **Anexos.** O servidor 0.4.0 guarda textos em `<dataDir>/<project>/attachments/<sha256>`, endereçados pelo sha256 dos bytes UTF-8, com teto de 1 MiB **em bytes**, dedupe por `link` exclusivo e verificação em `chain`, `timeline` e `state`. A tool `attachment` faz o put por `text` ou por `path` (restrito a um `.md` direto em `<cwd do servidor>/.omc/plans`, aberto com `O_NOFOLLOW`, regular, de um único link, com leitura limitada e com o caminho do descritor conferido contra o esperado depois do `open`) e o get paginado por `hash`. O evento referencia o blob por `data.attachment: <hash>`, em tipos custom cujo schema declara o campo.
2. **Tipos custom.** Cinco tipos (`planner-adr`, `architect-review`, `critic-findings`, `plan-iteration-diff`, `deviation`), com resumos orçados para caber com escape ×2 em 16.000 caracteres canônicos. Os schemas vivem em `.hexlog/types/*.json` (fonte versionada dos `register_type` e do cálculo offline de `hashes.schemas`). Como todo tipo custom, só entram em processos criados depois de registrados (ADR 0002).
3. **`supersedes` de tipo custom.** `register` passa a validar que cada id existe no log do mesmo processo (`UNKNOWN_ID`, com a lista dos ausentes) e que é evento de tipo custom (`INVALID_EVENT`, `not_custom`): a supersessão de Veredito continua exclusiva do `state`.
4. **Timeline.** A tool `timeline` e o CLI `scripts/timeline.ts` cruzam todos os processos do projeto por target, em ordem cronológica, com os superados marcados (`supersededBy`), o estado da cadeia por processo e o `attachment.status` por entrada, sempre, com ou sem `full`. O CLI não tem teto de página nem de texto por entrada; a tool limita o texto por entrada a 8.000 caracteres e aponta para `attachment` para o resto.
5. **12 tools.** `attachment` e `timeline` se somam às 10 anteriores; `TOOLS_COUNT` passa a 12 e a versão do servidor a 0.4.0.
6. **Registro pelo orquestrador.** O orquestrador OMC (plan, ralplan, autopilot, ralph, team) registra racional e desvios. O blob do architect é guardado logo depois do retorno dele, e o `architect-review` só é registrado depois do retorno do Critic, para que nenhum evento do architect da iteração corrente exista enquanto o Critic trabalha. O texto anexado de architect e critic é o **relatório entregue** ao orquestrador (retorno da Task; corpo do `SendMessage` ao lead quando o agente tem `name`), nunca o recap nem um texto de trabalho. O `architect-review` é só registro auditável: sem Veredito companheiro em `state` e sem gate. A ordem de chamadas é: `attachment` primeiro, `register` com o hash depois.
7. **Vocabulário do veredito do Critic.** `critic-findings.verdict` guarda o rótulo literal do Critic em minúsculas (`reject`, `revise`, `accept-with-reservations`, `accept`); `plan-review.result` registra o que o orquestrador **fez**:

   | Rótulo do Critic | O que o orquestrador faz | `plan-review.result` |
   |---|---|---|
   | `accept` | fecha o loop | `approve` |
   | `accept-with-reservations` | aplica as melhorias ao plano e fecha o loop | `approve` (`iterate` só se optar por redigir de novo: então existe o `planner-adr` seguinte) |
   | `revise` ou `reject`, com iteração restante | re-draft e nova iteração | `iterate` |
   | `revise` ou `reject`, no teto de iterações | sem nova iteração: marco `escalated` mais `deviation`, sem ralph | `reject` |
   | `plan --review` (só Critic, sem loop) | devolve o veredito ao usuário | `approve`, `request-changes` ou `reject`; nunca `iterate` |

   As invariantes são conferíveis por máquina: `iterate` implica um `planner-adr` da iteração seguinte (ou `escalated`), `approve` implica `execution-approval`, `reject` implica `escalated`.
8. **Skill `hexlog-flow`.** Corrigida (o erro de que `chain` seguia superados) e ampliada para documentar o registro de desvio e racional, a `timeline` e o que `state` omite. Fora do escopo deste repositório de servidor: o texto dos grupos de registro no fork OMC e a recriação dos quatro processos do piloto, que só acontece depois de os schemas serem ensaiados com LLM real e de a cadeia ensaiado, fixado e publicado ser conferida offline.

## Drivers

- Auditabilidade pós-execução: texto integral, resumo, superados e estado de integridade numa única visão.
- Irreversibilidade: schemas fixados por processo e dados que só o usuário mexe; ensaio antes, cadeia conferida offline, remoção reversível.
- Limites reais do host MCP e adesão do LLM: payload de até 240 KB, página de 24.000 caracteres, saída duplicada, tokens de reemissão e instruções que o LLM já ignorou; o desenho precisa funcionar dentro deles e ser verificável.

## Alternatives Considered

- **Superfície do anexo.** Só `text` (o plano de 110 a 240 KB estoura o teto de saída por turno e é reemitido a cada erro); `register` com `attachment: <texto>` injetando o hash (validação errada reemite o texto inteiro e ramifica os tipos nativos, que são `strictObject`); só `path` (o servidor lê arquivo a pedido do agente e architect/critic não estão em disco). Escolhido o híbrido: `text` para o que cabe, `path` restrito para o plano, `get` paginado, CLI para texto grande. Regra de degradação: se o `path` for negado, o orquestrador copia o plano para `.omc/plans/<slug>.iter<N>.md` e tenta de novo; se ainda negado, registra um `deviation` e anexa por `text` um texto-ponteiro.
- **Modelagem dos tipos.** Um tipo `rationale` com `kind` e `oneOf` (schema único perto do teto, perde o filtro nativo por tipo, validação mais frouxa); estender Marco e Veredito (mexe no núcleo, quebra o ADR 0002 e traria o architect para a supersessão do gate). Escolhidos cinco tipos custom, um por intenção; a vantagem da opção rejeitada (validar `supersedes`) foi atendida sem tocar no núcleo.
- **Quem registra desvio.** Vinte e quatro pontos soltos no fork (irrealista, cada ponto extra é uma instrução a ser ignorada); o executor chamando o hexlog direto (não vê os desvios do orquestrador e acopla o agente ao hexlog); captura determinística por hook (não conhece `slug` nem `iteration`, campos obrigatórios; o ADR 0005 retirou o hook a pedido do usuário). Escolhido o orquestrador, com dez grupos de registro ancorados em passos que ele já executa.
- **Independência Architect/Critic.** `disallowedTools` de hexlog no agente Critic (segundo agente divergente do upstream); só instrução (é o modo de falha já observado); registrar `architect-review(N)` só depois do Critic(N+1) (segunda regra de ordenação entre iterações). Escolhido registrar o evento depois do retorno do Critic, com o blob guardado antes.
- **Passo destrutivo sobre os processos do piloto.** `rm -rf` depois de exportar o JSONL (o JSONL não restaura, e o `rm` é irreversível); `cp` verificado seguido de `rm`. Escolhido `mv` para uma quarentena no mesmo filesystem, com allowlist, simulação antes e `attachments/` copiado.
- **Onde ensaiar.** No próprio repositório com troca de uma linha do mapa do fluxo (sessão viva, arquivo rastreado); repositório `git init` mínimo (sem o mapa real nem as configurações). Escolhido um clone isolado mais um projeto descartável.
- **Fonte do sha256 do anexo.** Último texto do subagente, maior texto ou "pelo menos 90% do maior" (rejeitadas: em 27 de 313 transcrições reais o `SendMessage` é menor que o texto de trabalho).

## Why this one

Cada escolha fecha o driver que a motivou: o híbrido `text`/`path` e o `get` paginado cabem no host; o relatório entregue ao orquestrador dá ao hash um referente verificável; o ensaio em clone, o `mv` reversível e a cadeia conferida offline protegem o que só o usuário mexe.

## Consequences

- O invariante de dez tools deixa de valer. Este ADR **reverte a rejeição de "tool nova de busca multi-processo"** registrada no ADR 0001, que está congelado e por isso não recebe emenda: a reversão vive aqui. O ADR 0002 (critério de `tools/list` com dez tools) e o ADR 0005 (invariante das dez tools) ganham uma seção de emenda apontando para este.
- Blobs são imutáveis e sem coleta de lixo: o armazenamento só cresce, e blob órfão é possível (o fluxo é em dois passos: `attachment`, depois `register`; o blob do architect existe antes do evento dele).
- Backup de processo com anexos exige copiar o diretório do projeto, não só o JSONL.
- A verificação de anexo em `state` usa um memo por `(caminho, ino, size, mtimeMs, ctimeMs)`: escrita in place muda o `ctime`, então adulterar preservando `size` e `mtime` é visto. O resíduo é falsificar o `ctime`. `chain` e `timeline` nunca usam o memo.
- O `path` só funciona com o `cwd` que o servidor herdou do Claude Code: não funciona com `OMC_STATE_DIR`, `.omc-workspace`, sessão iniciada em subdiretório ou worktree ligado, casos em que cai na regra de degradação. Entre a resolução do diretório e a abertura do arquivo existe uma janela de corrida, fechada depois do `open` conferindo o caminho do descritor (`/proc/self/fd`; sem /proc, o diretório é resolvido de novo e o `dev`/`ino` do descritor é comparado com o do caminho), e um hardlink para fora de `.omc/plans` é recusado (`nlink` maior que 1). Os erros do `path` não devolvem errno nem caminho absoluto: qualquer falha na resolução dos diretórios é `outside_allowed_root`, arquivo ausente é `not_found`. Um blob que seja symlink, FIFO, diretório ou maior que o teto conta como adulterado.
- Tipos novos só existem em processos recriados (ADR 0002). O `at` do `architect-review` é o instante do registro, não o do término do architect. O `architect-review(N)` é legível pelo Critic da iteração N+1: mitigado por instrução no prompt e por varredura no ensaio, não por construção.
- O hash prova o armazenado, não que a cópia seja o relatório que o agente entregou: isso é verificado por amostra, contra o canal de entrega, no ensaio.
- **Exceção à regra de hash canônico.** O hash do anexo é o sha256 dos **bytes** UTF-8, não do JCS (`src/AGENTS.md` registra a regra geral): o blob é texto opaco, não um objeto JSON.
- Chegar ao teto de iterações do Critic sem aprovação é um resultado válido (o fluxo termina em `escalated`, sem ralph), não uma falha de adesão.

## Follow-ups

- `export` com anexos e restauração.
- Coleta de lixo de blobs órfãos.
- Cota de armazenamento por projeto: hoje um agente pode encher o disco gravando blobs de até 1 MiB sem limite total.
- Opt-in de verificação forte de anexo no `state`.
- Gate custom `audit-complete`.
- Ingestão por `path` para além de `.omc/plans` só com nova decisão.
- `project` no frontmatter do `flow.md` (exige mudar o schema da `hexlog-setup`).
- Captura de texto por hook no `SubagentStop`, só por gatilho de dados e se o ADR 0005 for revisto.
