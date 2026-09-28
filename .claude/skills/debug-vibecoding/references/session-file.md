# Arquivo de sessão

Lido nos Passos 1 (retomada) e 6 (gravação). Caminho: `.ignore/debug/PR<n>.md` na raiz do repositório. Um arquivo por PR.

## Formato

```markdown
# Debug PR #<n> — <título>

- head: `<sha>` · início: <AAAA-MM-DD> · atualizado: <AAAA-MM-DD HH:MM>
- estado: em andamento | pendências abertas | fechado

## Contexto

<origem do trabalho, temas, decisão central, o que ficou de fora; 5–10 linhas>

## Checagens

| # | resultado | evidência |
|---|---|---|
| C1 | falhou | corpo escrito às 12:57, levas 11–16 às 15:40 |

## Decisões

| id | decisão | estado | nota |
|---|---|---|---|
| D1 | contrato enxuto por padrão | aceita | premissa P3: consumidor único |
| D3 | adiar #8 e #17 | aceita | #8 revertida na iter6 |
| E4 | acionamento por hook | questionada → removida | pendência 4 |

Estados: aberta · aceita · questionada · removida · virou pendência.

## Pendências

| # | o quê | destino | estado | link |
|---|---|---|---|---|
| 1 | corpo do PR desatualizado | PR | resolvida | <url> |
| 3 | avisos repetidos após gravar | issue | resolvida | #33 |

## Ajustes na skill

- <correção do usuário sobre a condução, com a data>
```

## Retomada

Leia o arquivo, confira o head do PR contra `head:`. Se mudou, liste os commits novos e pergunte se reabre alguma decisão. Siga da primeira decisão `aberta`; depois, das pendências não resolvidas.
