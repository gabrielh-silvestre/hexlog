# Estratégia

Premissas atemporais do hexlog, em linguagem de produto: o que não pode quebrar e por quê. Cada decisão registrada deve se apoiar em pelo menos uma delas, ou declarar que nenhuma se aplica. Só mudam com validação do dono; o agente nunca as edita sozinho. O detalhe técnico mora no doc ligado em cada linha.

## Stack

- `libs-fixas`: As dependências ficam em versão exata: nenhuma atualização entra sem ser decidida, para o comportamento não mudar por baixo. Ver: [convencoes.md](convencoes.md).
- `troca-confere-adrs`: Trocar uma biblioteca ou decisão de stack só depois de conferir os ADRs e a pesquisa, onde a maioria das alternativas já foi avaliada e tem motivo registrado. Ver: [documentacao.md](documentacao.md).
- `node-minimo`: O produto exige a versão mínima de Node declarada em `engines`; versão menor não é suportada. Ver: [qualidade-e-testes.md](qualidade-e-testes.md).
- `validacao-por-esquema`: Entradas e registros são validados por esquema (Zod nas entradas, JSON Schema no conteúdo dos registros), nunca por checagem solta. Ver: [convencoes.md](convencoes.md).
- `hooks-sem-dependencia`: Os hooks do fluxo são TypeScript sem dependência externa e ficam fora do pacote do produto, para não pesá-lo nem herdar risco de terceiros. Ver: [instalacao-e-hooks.md](instalacao-e-hooks.md).

## Integridade de dados

- `log-so-acrescenta`: O histórico de cada trabalho só cresce: nenhum registro é editado ou apagado depois de gravado. Ver: [invariantes.md](invariantes.md).
- `cadeia-detecta-adulteracao`: Cada registro carrega a marca do anterior, então qualquer alteração externa no histórico é detectada e nunca passa despercebida. Ver: [invariantes.md](invariantes.md).
- `gravacao-completa-ou-nada`: Um pedido de registro grava tudo ou nada, em um só trabalho, e dois agentes nunca gravam ao mesmo tempo no mesmo histórico sem proteger a integridade. Ver: [invariantes.md](invariantes.md).
- `anexo-imutavel`: Texto anexado é endereçado pelo próprio conteúdo, nunca é sobrescrito e é conferido a cada leitura. Ver: [invariantes.md](invariantes.md).
- `definicao-fixada-por-processo`: Cada trabalho fixa as versões das definições ao nascer; mudança que quebra exige trabalho novo, nunca reescrita do que já existe. Ver: [invariantes.md](invariantes.md).
- `dado-antigo-arquivado`: O dado da versão 0.x nunca é perdido nem lido em silêncio: é arquivado, com ponto de retorno, antes de a 1.0 assumir. Ver: [instalacao-e-hooks.md](instalacao-e-hooks.md).

## Contrato público

- `ferramentas-fixas`: O conjunto de ferramentas que o agente enxerga é fixo; acrescentar ou remover uma é decisão de contrato, conferida pelos testes do instalador. Ver: [invariantes.md](invariantes.md).
- `erro-estruturado`: Nenhuma falha interna chega ao agente como exceção solta nem expõe detalhe interno: toda recusa traz código e motivo estruturados. Ver: [invariantes.md](invariantes.md).
- `codigos-de-erro-estaveis`: Os códigos de erro são parte do contrato: remover ou renomear um quebra quem depende dele; acrescentar não. Ver: [adr-0009-ferramental.md](adr-0009-ferramental.md).
- `vigencia-so-no-processo`: Substituir ou revogar um registro só alcança o próprio trabalho; um trabalho nunca invalida o de outro. Ver: [adr-0007-dominio.md](adr-0007-dominio.md).
- `gates-com-perguntas-fixas`: Os gates só fazem as poucas perguntas já definidas; um tipo novo de pergunta é decisão de contrato, não ajuste. Ver: [adr-0007-dominio.md](adr-0007-dominio.md).
- `saidas-com-teto`: Toda lista devolvida tem teto e diz o que cortou; remover um teto ou estourá-lo em silêncio muda o contrato. Ver: [convencoes.md](convencoes.md).

## Segurança e riscos aceitos

- `anexo-so-texto-do-projeto`: Só texto .md ou .txt dentro da pasta de trabalho do servidor e fora do diretório de dados pode ser anexado; ampliar esse alcance exige um ADR novo. Ver: [invariantes.md](invariantes.md).
- `hooks-sao-freios`: Os hooks pegam descuido, não burla: o bloqueio de acesso ao diretório de dados cobre só o Bash, libera na dúvida e nega só o que passa do limite de custo; o de abertura de PR nega na dúvida; o marcador do pré-PR qualquer agente com escrita forja. Ver: [instalacao-e-hooks.md](instalacao-e-hooks.md).
- `diretorio-de-dados-confiavel`: O diretório de dados é tratado como confiável: não há defesa contra quem já controla a máquina (links simbólicos e pipes são limite aceito). Ver: [adr-0009-ferramental.md](adr-0009-ferramental.md).
- `entrada-do-agente-contida`: O que o agente envia não pode travar o servidor nem o terminal: expressões regulares catastróficas, referências externas em esquema e caracteres de controle na saída são tratados. Ver: [adr-0009-ferramental.md](adr-0009-ferramental.md).
- `riscos-conhecidos-aceitos`: Os limites já documentados (lock por pid, corrida entre processos, busca sem teto agregado de memória, verificação que não confere data) são riscos aceitos; resolver um deles é decisão nova. Ver: [adr-0008-servicos.md](adr-0008-servicos.md).

## Escopo e processo

- `nucleo-sem-termo-de-fluxo`: O código do produto é agnóstico: não conhece nenhum fluxo de trabalho; o fluxo vive em definições e docs, nunca no código. Ver: [invariantes.md](invariantes.md).
- `camadas-com-direcao`: Cada camada só depende das de baixo, e consultar nunca grava; quebrar essa direção é achado urgente em review. Ver: [fronteiras.md](fronteiras.md).
- `so-linux`: O produto só é suportado no Linux; outros sistemas não foram testados. Ver: [instalacao-e-hooks.md](instalacao-e-hooks.md).
- `adr-aceito-so-por-emenda`: ADR aceito não é reescrito, só recebe emenda, e a pesquisa congelada não se edita; mudança de rumo vai num ADR novo. Ver: [documentacao.md](documentacao.md).
- `camada-fina-sobre-o-omc`: As regras de uso valem por cima do OMC sem alterá-lo: skill de entrada fina, doc importado, ponteiro ao iniciar subagente e bloqueio de PR sem marcador; nada reescreve a entrada do agente. Ver: [adr-0010-camada-sobre-omc.md](adr-0010-camada-sobre-omc.md).
- `decisao-registrada-por-quem-decide`: Toda escolha entre alternativas viáveis vira registro feito por quem a tomou, inclusive subagente, e nunca delegado a outro. Ver: [fluxo-hexlog.md](fluxo-hexlog.md).
- `lacuna-fecha-por-regra-explicita`: Uma lacuna só se fecha por regra escrita ou premissa registrada, nunca por decisão refeita; PR com lacuna aberta nasce em rascunho e só sai dele com as lacunas fechadas e a verificação refeita. Ver: [fluxo-hexlog.md](fluxo-hexlog.md).

## Propósito e modos de uso

- `audita-decisoes-de-agentes`: O hexlog existe para auditar decisões de agentes de IA: o que foi decidido, por quê e com que evidência. Ver: [adr-0011-camada-estrategica.md](adr-0011-camada-estrategica.md).
- `dois-modos-de-uso`: Há dois modos: acompanhado (modo `ask`), em que o humano decide e o agente explora, coleta evidência e pesquisa; e autônomo (modo `autonomous`, o padrão), em que o agente decide dentro de objetivos, diretrizes e premissas e registra. Ver: [fluxo-hexlog.md](fluxo-hexlog.md).
- `decisao-registrada-e-reversivel`: Toda decisão fica registrada para auditoria posterior e pode ser revertida; nada decidido some do histórico. Ver: [fluxo-hexlog.md](fluxo-hexlog.md).
- `decisao-refutavel`: Toda decisão pode ser refutada por revisão de pares, com o porquê e as evidências rastreáveis, e o processo se ajusta ao que a refutação revela. Ver: [adr-0011-camada-estrategica.md](adr-0011-camada-estrategica.md).
- `melhoria-continua`: O registro serve à melhoria contínua: o que a auditoria revela vira regra ou premissa melhor. Ver: [adr-0011-camada-estrategica.md](adr-0011-camada-estrategica.md).

## Nenhuma premissa se aplica

- `none`: Nenhuma premissa se aplica a esta decisão.
