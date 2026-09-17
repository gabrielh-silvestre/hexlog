import type { McpServer } from '@modelcontextprotocol/server';
import canonicalize from 'canonicalize';
import { isNil, isNotNil } from 'es-toolkit';
import { z } from 'zod';
import { buscar, ehCandidato, TETO_BUSCA_CHARS, type Filtros } from './busca.ts';
import { eloValido, verificarCadeia, type Cadeia } from './cadeia.ts';
import { carregarProcesso, type ProcessoCarregado } from './definicoes.ts';
import { detalhesDeIssues, ErroHexlog, type Detalhe } from './erros.ts';
import { analisarId, Alvo, esquemaDados, Linha, normalizarDados, Rotulo } from './eventos.ts';
import { agoraEfetivo, projetar, validarCampo, type CampoVocabulario, type Estado, type Vocabulario } from './estado.ts';
import {
  avaliarEmbutido,
  ehGateEmbutido,
  GATES_EMBUTIDOS,
  montarDadosMarcoGate,
  normalizarProvaCustom,
  TETO_ITEM_PROVA_CHARS,
  TETO_PROVA_CUSTOM,
  type NomeGateEmbutido,
  type ResultadoGate,
} from './gates.ts';
import { anexar, lerTexto } from './log.ts';
import {
  Agente,
  Aviso as AvisoSchema,
  Cadeia as CadeiaSchema,
  type Contexto,
  executar,
  Instante,
  Nome,
  Ref,
  Secao,
  TETO_ITENS_SECAO,
  TETO_PAGINA_CHARS,
} from './mcp.ts';

type AvisoSaida = z.infer<typeof AvisoSchema>;
type NomeSecao = z.infer<typeof Secao>;

/** Registra as 5 tools de eventos (`registrar`, `avaliar_gate`, `estado`, `eventos`, `cadeia`). */
export function registrarFerramentasEventos(servidor: McpServer, ctx: Contexto): void {
  servidor.registerTool(
    'registrar',
    {
      title: 'Registrar evento',
      description:
        'Registra um evento (Marco, Veredito ou tipo custom fixado) no processo. `id` pode ser um **prefixo** ' +
        '`{projeto}:{processo}:{tipo}` (o servidor gera um uuid v7 novo e faz append) ou um **id completo** ' +
        '`{projeto}:{processo}:{tipo}:{uuid}` devolvido por uma chamada anterior: retentativa idempotente, mesmo ' +
        '`tipo`/`agente`/`dados` normalizados devolve a linha existente com `deduplicado: true`; conteúdo diferente ' +
        'é `ID_CONFLITANTE`. Marco aceita `marcoTipo`, `alvo` (`hex:alvo:<id>`), `contagem`, `prazoExecucao` e ' +
        '`decisoes[]`; Veredito aceita `afirmacao`, `fonte`, `resultado`, `prova`, `destino` (`hex:alvo:<id>`), ' +
        '`supera[]`, `origem` e `rastro`. `marcoTipo: "gate"` e a chave `gate` são reservados ao Marco gerado por ' +
        '`avaliar_gate`.',
      inputSchema: {
        projeto: Nome,
        processo: Nome,
        id: z.string().min(1).max(260),
        agente: Agente,
        dados: z.record(z.string(), z.unknown()),
      },
      outputSchema: { evento: Linha, deduplicado: z.boolean(), avisos: z.array(AvisoSchema) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projeto, processo, id, agente, dados }) =>
      executar(ctx, 'registrar', { projeto, processo }, () => registrar(ctx, { projeto, processo, id, agente, dados })),
  );

  servidor.registerTool(
    'avaliar_gate',
    {
      title: 'Avaliar gate',
      description:
        'Avalia um gate contra `alvo` e grava o resultado como um Marco de gate. Gate embutido (`sem-orfaos`, ' +
        '`sem-conflitos`, `cadeia-integra`, `sem-referencias-invalidas`) não aceita `resultado`: é calculado a ' +
        'partir do Estado atual do processo. Gate custom, fixado no processo, exige `resultado: {passou, prova}`. ' +
        'O Marco de gate registrado nunca abre nem fecha o ciclo do alvo: avaliar `sem-orfaos` sobre um Marco ' +
        'vencido não faz esse Marco deixar de aparecer em `estado.orfaos`.',
      inputSchema: {
        projeto: Nome,
        processo: Nome,
        gate: Nome,
        agente: Agente,
        alvo: Alvo,
        resultado: z
          .object({
            passou: z.boolean(),
            prova: z.union([
              z.string().min(1).max(TETO_ITEM_PROVA_CHARS),
              z.array(z.string().min(1).max(TETO_ITEM_PROVA_CHARS)).min(1).max(TETO_PROVA_CUSTOM),
            ]),
          })
          .optional(),
      },
      outputSchema: { evento: Linha, passou: z.boolean(), prova: z.array(z.unknown()), totalItensProva: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projeto, processo, gate, agente, alvo, resultado }) =>
      executar(ctx, 'avaliar_gate', { projeto, processo }, () =>
        avaliarGate(ctx, { projeto, processo, gate, agente, alvo, resultado }),
      ),
  );

  servidor.registerTool(
    'estado',
    {
      title: 'Estado',
      description:
        'Projeta o Estado atual do processo: vigentes/conflitos de Veredito, Marcos órfãos, eventos a revisar, ' +
        'referências inválidas, avisos de vocabulário e a cadeia de hash. `secoes` filtra o que volta na resposta; ' +
        'sem informar, todas voltam. Cada lista é cortada em 100 itens e `totais` traz o tamanho real de cada uma.',
      inputSchema: { projeto: Nome, processo: Nome, secoes: z.array(Secao).min(1).optional() },
      outputSchema: {
        logAte: Ref.nullable(),
        agora: Instante,
        totais: z.record(z.string(), z.number().int()),
        vigentes: z
          .array(
            z.object({
              destino: z.string(),
              afirmacao: z.string(),
              status: z.enum(['vigente', 'conflito']),
              vigente: z.string().optional(),
              candidatos: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        conflitos: z.array(z.object({ destino: z.string(), afirmacao: z.string(), candidatos: z.array(z.string()) })).optional(),
        orfaos: z.array(z.object({ marco: z.string(), alvo: z.string(), prazoExecucao: Instante })).optional(),
        aRevisar: z.array(z.string()).optional(),
        referenciasInvalidas: z.array(z.object({ citadaPor: z.string(), referencia: z.string() })).optional(),
        avisos: z
          .array(
            z.object({
              evento: z.string(),
              campo: z.enum(['marcoTipo', 'resultado', 'decisoes.acao']),
              valor: z.string(),
              classe: z.enum(['extensao', 'aviso-desconhecido', 'erro']),
              dono: z.string().nullable(),
            }),
          )
          .optional(),
        cadeia: CadeiaSchema.optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projeto, processo, secoes }) =>
      executar(ctx, 'estado', { projeto, processo }, () => resolverEstado(ctx, { projeto, processo, secoes })),
  );

  servidor.registerTool(
    'eventos',
    {
      title: 'Eventos',
      description:
        'Lista os eventos do log de um processo. Sem `busca`: ordem física, a partir do índice físico `desde` ' +
        '(modo cru). Com `busca` (2 a 200 caracteres): índice de texto construído nesta chamada só sobre os ' +
        'candidatos, ordenado por relevância decrescente (modo busca); `combinacao` informa se a consulta casou em ' +
        '`AND` ou caiu no fallback `OR`. Filtros por igualdade exata, combináveis com `busca` ou sozinhos: `tipo`, ' +
        '`alvo` (`dados.alvo`/`dados.destino`), `marcoTipo`, `resultado` e o intervalo `[apos, antes)` de ' +
        '`timestamp`. A busca textual **não encontra** endereços `hex:alvo:<id>` nem ids de evento; para endereço, ' +
        'use o filtro `alvo` (não há filtro por id de evento). Uma página cabe em `limite` eventos e no teto de ' +
        '24 000 caracteres, exceto o primeiro evento da página, que sempre entra mesmo sozinho acima do teto. ' +
        '`ate` congela o prefixo do arquivo considerado (linhas físicas de índice < `ate`); sem informar, a ' +
        'chamada usa todas as linhas do momento e devolve esse número em `ate`. Para páginas seguintes estáveis, ' +
        'reenvie o mesmo `ate` recebido e use `proximoCursor` como `desde`: sem `ate`, um `registrar` entre ' +
        'páginas pode repetir ou omitir itens na fronteira. `proximoCursor` é `null` no fim (índice físico no modo ' +
        'cru; posição no ranking no modo busca). `linhasInvalidas` lista os índices físicos que não são um elo ' +
        'válido: só desta página no modo cru, do arquivo inteiro (até 100) no modo busca.',
      inputSchema: {
        projeto: Nome,
        processo: Nome,
        desde: z.number().int().min(0).default(0),
        limite: z.number().int().min(1).max(200).default(50),
        tipo: Nome.optional(),
        busca: z.string().trim().min(2).max(TETO_BUSCA_CHARS).optional(),
        alvo: Alvo.optional(),
        marcoTipo: Rotulo.optional(),
        resultado: Rotulo.optional(),
        apos: Instante.optional(),
        antes: Instante.optional(),
        ate: z.number().int().min(0).optional(),
      },
      outputSchema: {
        modo: z.enum(['cru', 'busca']),
        eventos: z.array(Linha.extend({ relevancia: z.number().optional() })),
        combinacao: z.enum(['AND', 'OR']).optional(),
        ate: z.number().int(),
        linhasInvalidas: z.array(z.number().int()).max(100),
        proximoCursor: z.number().int().nullable(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projeto, processo, desde, limite, tipo, busca, alvo, marcoTipo, resultado, apos, antes, ate }) => {
      let logExtra: Record<string, unknown> = {};
      return executar(
        ctx,
        'eventos',
        { projeto, processo },
        () => {
          const { saida, extra } = resolverEventos(ctx, {
            projeto,
            processo,
            desde,
            limite,
            tipo,
            busca,
            alvo,
            marcoTipo,
            resultado,
            apos,
            antes,
            ate,
          });
          logExtra = extra;
          return saida;
        },
        () => logExtra,
      );
    },
  );

  servidor.registerTool(
    'cadeia',
    {
      title: 'Cadeia',
      description:
        'Verifica a cadeia de hash do log do processo: sequência, encadeamento a partir da âncora de ' +
        '`processo.json` e a validade de `dados` contra o schema fixado de cada tipo. `quebras` e ' +
        '`linhasReparadas` vêm cortadas em 100 itens, com os totais reais.',
      inputSchema: { projeto: Nome, processo: Nome },
      outputSchema: CadeiaSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projeto, processo }) => executar(ctx, 'cadeia', { projeto, processo }, () => resolverCadeia(ctx, { projeto, processo })),
  );
}

// ---- helpers puros reutilizáveis (passos 7c e 8) ----

/**
 * Lê as linhas físicas de um log (§4.6: cauda sem `\n` descartada) e separa em elos com `dados`
 * validado contra o schema do seu `tipo` (nativo ou do snapshot) e linhas inválidas (envelope ou
 * `dados` reprovados). `linhasInvalidas` guarda o índice físico de cada linha fora dos elos.
 */
export function lerElos(
  texto: string,
  esquemasCustom: Record<string, z.ZodType>,
): { elos: Linha[]; linhasInvalidas: number[]; linhasFisicas: string[] } {
  const linhasFisicas = texto.split('\n').slice(0, -1);
  const elos: Linha[] = [];
  const linhasInvalidas: number[] = [];

  linhasFisicas.forEach((linhaTexto, indice) => {
    const elo = eloValido(linhaTexto);
    if (isNotNil(elo) && dadosValidos(elo, esquemasCustom)) {
      elos.push(elo);
      return;
    }
    linhasInvalidas.push(indice);
  });

  return { elos, linhasInvalidas, linhasFisicas };
}

function dadosValidos(elo: Linha, esquemasCustom: Record<string, z.ZodType>): boolean {
  const esquema = esquemaDados(elo.tipo, elo.dados, esquemasCustom) as z.ZodType | undefined;
  return isNotNil(esquema) && esquema.safeParse(elo.dados).success;
}

/** `validarDados` de `verificarCadeia` (§4.6): reprova `dados` fora do schema fixado do seu `tipo`. */
export function validarDadosDoProcesso(
  esquemasCustom: Record<string, z.ZodType>,
): (tipo: string, dados: Record<string, unknown>) => Detalhe[] | null {
  return (tipo, dados) => {
    const esquema = esquemaDados(tipo, dados, esquemasCustom) as z.ZodType | undefined;
    if (isNil(esquema)) {
      return [{ caminho: '', codigo: 'tipo_desconhecido', mensagem: `tipo '${tipo}' não está fixado no processo` }];
    }
    const resultado = esquema.safeParse(dados);
    return resultado.success ? null : detalhesDeIssues(resultado.error.issues, '');
  };
}

/** Projeta o Estado completo do processo (§4.8) a partir do texto atual do log. */
export function montarEstado(
  processo: ProcessoCarregado,
  texto: string,
  relogio: () => Date,
): Estado & { agora: string } {
  const { elos } = lerElos(texto, processo.esquemasCustom);
  const agora = agoraEfetivo(relogio().toISOString(), elos);
  const projecao = projetar(elos, processo.manifesto.fixado.vocabulario, agora);
  const cadeia = verificarCadeia(texto, processo.manifesto, validarDadosDoProcesso(processo.esquemasCustom));
  return { ...projecao, cadeia, agora };
}

// ---- registrar ----

function registrar(
  ctx: Contexto,
  args: { projeto: string; processo: string; id: string; agente: string; dados: Record<string, unknown> },
): { evento: Linha; deduplicado: boolean; avisos: AvisoSaida[] } {
  const { projeto, processo, id, agente, dados } = args;
  const carregado = carregarProcesso(ctx.dirDados, projeto, processo);
  const { tipo, uuid } = validarIdDoEvento(id, projeto, processo);

  if (tipo !== 'marco' && tipo !== 'veredito' && isNil(carregado.esquemasCustom[tipo])) {
    throw new ErroHexlog('TIPO_NAO_FIXADO', `tipo '${tipo}' não está fixado no processo`);
  }
  if (tipo === 'marco' && temCampoReservado(dados)) {
    throw new ErroHexlog('CAMPO_RESERVADO', 'marcoTipo "gate" e a chave "gate" são reservados ao Marco de gate de avaliar_gate');
  }

  const normalizados = normalizarDados(tipo, dados, carregado.esquemasCustom);
  const avisos = aplicarVocabulario(tipo, normalizados, carregado.manifesto.fixado.vocabulario);

  if (isNotNil(uuid)) {
    return { ...retentarComIdCompleto(carregado, id, tipo, agente, normalizados), avisos };
  }

  const linha = anexar(
    carregado.arquivoEventos,
    carregado.manifesto,
    (base) => ({
      seq: base.seq,
      id: `${id}:${base.uuid}`,
      tipo,
      timestamp: base.timestamp,
      agente,
      prevHash: base.prevHash,
      dados: normalizados,
    }),
    { log: ctx.log, relogio: ctx.relogio },
  );
  return { evento: linha, deduplicado: false, avisos };
}

function validarIdDoEvento(id: string, projeto: string, processo: string): { tipo: string; uuid?: string } {
  const analisado = analisarId(id);
  if (isNil(analisado) || analisado.projeto !== projeto || analisado.processo !== processo) {
    throw new ErroHexlog('ID_INVALIDO', 'id inválido para este projeto/processo', [
      { caminho: '/id', codigo: 'id_invalido', mensagem: 'id não casa a gramática esperada ou diverge de projeto/processo' },
    ]);
  }
  return analisado;
}

function temCampoReservado(dados: Record<string, unknown>): boolean {
  return dados.marcoTipo === 'gate' || 'gate' in dados;
}

/** Retentativa por id completo (§4.3): sem lock, compara `{tipo, agente, dados}` já normalizado. */
function retentarComIdCompleto(
  carregado: ProcessoCarregado,
  id: string,
  tipo: string,
  agente: string,
  normalizados: Record<string, unknown>,
): { evento: Linha; deduplicado: true } {
  const { elos } = lerElos(lerTexto(carregado.arquivoEventos), carregado.esquemasCustom);
  const existente = elos.find((elo) => elo.id === id);
  if (isNil(existente)) {
    throw new ErroHexlog('ID_DESCONHECIDO', `id '${id}' não encontrado`);
  }

  const enviado = canonicalize({ tipo, agente, dados: normalizados }) ?? '';
  const gravado = canonicalize({ tipo: existente.tipo, agente: existente.agente, dados: existente.dados }) ?? '';
  if (enviado !== gravado) {
    throw new ErroHexlog('ID_CONFLITANTE', `id '${id}' já usado com conteúdo diferente`);
  }

  return { evento: existente, deduplicado: true };
}

/** Vocabulário na escrita (§4.9): `marcoTipo`/`decisoes[].acao` fechados (erro); `resultado` aberto (aviso). */
function aplicarVocabulario(tipo: string, dados: Record<string, unknown>, vocabulario: Vocabulario): AvisoSaida[] {
  if (tipo === 'veredito') return avisoResultadoDesconhecido(dados, vocabulario);
  if (tipo === 'marco' && (dados as { marcoTipo: string }).marcoTipo !== 'gate') {
    validarVocabularioMarco(dados, vocabulario);
  }
  return [];
}

function validarVocabularioMarco(dados: Record<string, unknown>, vocabulario: Vocabulario): void {
  const marco = dados as { marcoTipo: string; decisoes?: { acao: string }[] };
  garantirVocabulario('marcoTipo', marco.marcoTipo, vocabulario, '/dados/marcoTipo');
  marco.decisoes?.forEach((decisao, indice) =>
    garantirVocabulario('decisoes.acao', decisao.acao, vocabulario, `/dados/decisoes/${indice}/acao`),
  );
}

function garantirVocabulario(campo: CampoVocabulario, valor: string, vocabulario: Vocabulario, caminho: string): void {
  if (validarCampo(vocabulario, campo, valor)?.classe === 'erro') {
    throw new ErroHexlog('VOCABULARIO_VIOLADO', `${campo} '${valor}' fora do vocabulário fixado`, [
      { caminho, codigo: 'vocabulario_violado', mensagem: `valor '${valor}' fora do vocabulário fixado` },
    ]);
  }
}

function avisoResultadoDesconhecido(dados: Record<string, unknown>, vocabulario: Vocabulario): AvisoSaida[] {
  const resultado = (dados as { resultado: string }).resultado;
  if (validarCampo(vocabulario, 'resultado', resultado)?.classe !== 'aviso-desconhecido') return [];
  return [
    {
      codigo: 'VOCABULARIO_DESCONHECIDO',
      mensagem: `resultado '${resultado}' fora do vocabulário conhecido`,
      detalhes: { campo: 'resultado', valor: resultado },
    },
  ];
}

// ---- avaliar_gate ----

type ResolucaoGate =
  | { origem: 'embutido'; nome: NomeGateEmbutido }
  | { origem: 'custom'; criterio: string; resultado: { passou: boolean; prova: string | string[] } };

function avaliarGate(
  ctx: Contexto,
  args: {
    projeto: string;
    processo: string;
    gate: string;
    agente: string;
    alvo: string;
    resultado?: { passou: boolean; prova: string | string[] };
  },
): { evento: Linha; passou: boolean; prova: unknown[]; totalItensProva: number } {
  const { projeto, processo, gate, agente, alvo, resultado } = args;
  const carregado = carregarProcesso(ctx.dirDados, projeto, processo);
  const resolucao = resolverGate(gate, resultado, carregado.manifesto.fixado.gates);
  const estado = montarEstado(carregado, lerTexto(carregado.arquivoEventos), ctx.relogio);

  const { resultadoGate, criterio } =
    resolucao.origem === 'embutido'
      ? { resultadoGate: avaliarEmbutido(resolucao.nome, estado), criterio: GATES_EMBUTIDOS[resolucao.nome].criterio }
      : { resultadoGate: avaliarGateCustom(resolucao.resultado, estado.logAte), criterio: resolucao.criterio };

  const dados = montarDadosMarcoGate({ nome: gate, origem: resolucao.origem, criterio, alvo, resultado: resultadoGate });
  const linha = anexar(
    carregado.arquivoEventos,
    carregado.manifesto,
    (base) => ({
      seq: base.seq,
      id: `${projeto}:${processo}:marco:${base.uuid}`,
      tipo: 'marco',
      timestamp: base.timestamp,
      agente,
      prevHash: base.prevHash,
      dados,
    }),
    { log: ctx.log, relogio: ctx.relogio },
  );

  return { evento: linha, passou: resultadoGate.passou, prova: resultadoGate.prova, totalItensProva: resultadoGate.totalItensProva };
}

/** §4.11: decide embutido × custom e valida a presença/ausência de `resultado`, antes de avaliar. */
function resolverGate(
  gate: string,
  resultado: { passou: boolean; prova: string | string[] } | undefined,
  gates: Record<string, { criterio: string }>,
): ResolucaoGate {
  if (ehGateEmbutido(gate)) {
    if (isNotNil(resultado)) {
      throw new ErroHexlog('AVALIACAO_INVALIDA', 'gate embutido não aceita resultado informado pelo agente');
    }
    return { origem: 'embutido', nome: gate };
  }

  const definicao = gates[gate];
  if (isNil(definicao)) {
    throw new ErroHexlog('GATE_NAO_REGISTRADO', `gate '${gate}' não está fixado no processo nem é embutido`);
  }
  if (isNil(resultado)) {
    throw new ErroHexlog('AVALIACAO_INVALIDA', 'gate custom exige resultado informado pelo agente');
  }
  return { origem: 'custom', criterio: definicao.criterio, resultado };
}

function avaliarGateCustom(resultado: { passou: boolean; prova: string | string[] }, logAte: Estado['logAte']): ResultadoGate {
  const prova = normalizarProvaCustom(resultado.prova);
  return { passou: resultado.passou, prova, totalItensProva: prova.length, avaliadoAte: logAte };
}

// ---- estado ----

const CAMPOS_LISTA = ['vigentes', 'conflitos', 'orfaos', 'aRevisar', 'referenciasInvalidas', 'avisos'] as const;
const TODAS_SECOES: NomeSecao[] = [...CAMPOS_LISTA, 'cadeia'];

function resolverEstado(
  ctx: Contexto,
  { projeto, processo, secoes }: { projeto: string; processo: string; secoes?: NomeSecao[] },
) {
  const carregado = carregarProcesso(ctx.dirDados, projeto, processo);
  const estado = montarEstado(carregado, lerTexto(carregado.arquivoEventos), ctx.relogio);
  const incluidas = new Set(secoes ?? TODAS_SECOES);

  const totais = Object.fromEntries(CAMPOS_LISTA.map((campo) => [campo, estado[campo].length]));
  const listas = Object.fromEntries(
    CAMPOS_LISTA.filter((campo) => incluidas.has(campo)).map((campo) => [campo, estado[campo].slice(0, TETO_ITENS_SECAO)]),
  );

  return {
    logAte: estado.logAte,
    agora: estado.agora,
    totais,
    ...listas,
    ...(incluidas.has('cadeia') ? { cadeia: estado.cadeia } : {}),
  };
}

// ---- eventos ----

type LinhaResultado = Linha & { relevancia?: number };

type SaidaEventos = {
  modo: 'cru' | 'busca';
  eventos: LinhaResultado[];
  combinacao?: 'AND' | 'OR';
  ate: number;
  linhasInvalidas: number[];
  proximoCursor: number | null;
};

type ArgsEventos = {
  projeto: string;
  processo: string;
  desde: number;
  limite: number;
  tipo?: string;
  busca?: string;
  alvo?: string;
  marcoTipo?: string;
  resultado?: string;
  apos?: string;
  antes?: string;
  ate?: number;
};

function resolverEventos(ctx: Contexto, args: ArgsEventos): { saida: SaidaEventos; extra: Record<string, unknown> } {
  const { projeto, processo, desde, limite, tipo, busca, alvo, marcoTipo, resultado, ate } = args;
  const carregado = carregarProcesso(ctx.dirDados, projeto, processo);

  validarMarcoTipoDoFiltro(marcoTipo, carregado.manifesto.fixado.vocabulario);
  const apos = normalizarInstante(args.apos);
  const antes = normalizarInstante(args.antes);
  validarIntervalo(apos, antes);

  const linhasFisicas = lerTexto(carregado.arquivoEventos).split('\n').slice(0, -1);
  validarAte(ate, linhasFisicas.length);
  const limiteAte = ate ?? linhasFisicas.length;

  const filtros: Filtros = { tipo, alvo, marcoTipo, resultado, apos, antes };

  return isNil(busca)
    ? resolverModoCru(linhasFisicas, limiteAte, desde, limite, filtros)
    : resolverModoBusca(linhasFisicas, limiteAte, desde, limite, filtros, busca);
}

/** `marcoTipo` fora de núcleo ∪ extensões e ≠ `"gate"` (sempre aceito) → `FILTRO_INVALIDO` (§4.12 item 9). */
function validarMarcoTipoDoFiltro(marcoTipo: string | undefined, vocabulario: Vocabulario): void {
  if (isNil(marcoTipo) || marcoTipo === 'gate') return;
  if (validarCampo(vocabulario, 'marcoTipo', marcoTipo)?.classe === 'erro') {
    throw new ErroHexlog('FILTRO_INVALIDO', `marcoTipo '${marcoTipo}' fora do vocabulário fixado`, [
      { caminho: '/marcoTipo', codigo: 'fora_do_vocabulario', mensagem: `valor '${marcoTipo}' fora do vocabulário fixado` },
    ]);
  }
}

/** `z.iso.datetime()` aceita entrada sem milissegundos; normaliza pra largura fixa antes de comparar. */
function normalizarInstante(v: string | undefined): string | undefined {
  return isNil(v) ? undefined : new Date(v).toISOString();
}

function validarIntervalo(apos: string | undefined, antes: string | undefined): void {
  if (isNil(apos) || isNil(antes) || apos < antes) return;
  throw new ErroHexlog('FILTRO_INVALIDO', 'apos deve ser anterior a antes', [
    { caminho: '/apos', codigo: 'intervalo_invalido', mensagem: `apos (${apos}) não é anterior a antes (${antes})` },
  ]);
}

/** `ate` além do fim do arquivo: o log tem menos linhas do que a página anterior viu. */
function validarAte(ate: number | undefined, totalLinhasFisicas: number): void {
  if (isNil(ate) || ate <= totalLinhasFisicas) return;
  throw new ErroHexlog('FILTRO_INVALIDO', `ate (${ate}) maior que o número de linhas do arquivo`, [
    { caminho: '/ate', codigo: 'ate_alem_do_arquivo', mensagem: `ate (${ate}) maior que ${totalLinhasFisicas} linhas físicas` },
  ]);
}

/**
 * Modo cru: ordem física a partir de `desde`, streaming (sem escanear além de onde a página para).
 * `candidatos` do log conta só os elos vistos durante essa varredura, não o total no arquivo inteiro
 * (decisão do passo 7c: evitar forçar leitura completa do arquivo numa chamada sem `busca`).
 */
function resolverModoCru(
  linhasFisicas: string[],
  limiteAte: number,
  desde: number,
  limite: number,
  filtros: Filtros,
): { saida: SaidaEventos; extra: Record<string, unknown> } {
  const eventos: Linha[] = [];
  const linhasInvalidas: number[] = [];
  let candidatos = 0;
  let proximoCursor: number | null = null;
  let tamanho = 2; // '[]'

  for (let indice = desde; indice < limiteAte; indice++) {
    const elo = eloValido(linhasFisicas[indice]!);
    if (isNil(elo)) {
      linhasInvalidas.push(indice);
      continue;
    }
    if (!ehCandidato(elo, filtros)) continue;
    candidatos++;

    const incremento = JSON.stringify(elo).length + (eventos.length > 0 ? 1 : 0);
    if (eventos.length > 0 && tamanho + incremento > TETO_PAGINA_CHARS) {
      proximoCursor = indice;
      break;
    }

    tamanho += incremento;
    eventos.push(elo);
    if (eventos.length >= limite) {
      proximoCursor = indice + 1 < limiteAte ? indice + 1 : null;
      break;
    }
  }

  return {
    saida: { modo: 'cru', eventos, ate: limiteAte, linhasInvalidas: linhasInvalidas.slice(0, 100), proximoCursor },
    extra: { modo: 'cru', candidatos },
  };
}

/** Candidatos e linhas inválidas do **arquivo inteiro** (§4.17): base do índice de texto do modo busca. */
function candidatosDoArquivo(
  linhasFisicas: string[],
  limiteAte: number,
  filtros: Filtros,
): { candidatos: { indice: number; linha: Linha }[]; linhasInvalidas: number[] } {
  const candidatos: { indice: number; linha: Linha }[] = [];
  const linhasInvalidas: number[] = [];

  linhasFisicas.forEach((linhaTexto, indice) => {
    const elo = eloValido(linhaTexto);
    if (isNil(elo)) {
      linhasInvalidas.push(indice);
      return;
    }
    if (indice < limiteAte && ehCandidato(elo, filtros)) {
      candidatos.push({ indice, linha: elo });
    }
  });

  return { candidatos, linhasInvalidas };
}

/** Modo busca (§4.12 item 9 e §4.17): índice construído nesta chamada, `desde`/`proximoCursor` no ranking. */
function resolverModoBusca(
  linhasFisicas: string[],
  limiteAte: number,
  desde: number,
  limite: number,
  filtros: Filtros,
  busca: string,
): { saida: SaidaEventos; extra: Record<string, unknown> } {
  const inicioIndice = Date.now();
  const { candidatos, linhasInvalidas } = candidatosDoArquivo(linhasFisicas, limiteAte, filtros);
  const { resultados, combinacao } = buscar(candidatos, busca);
  const msIndice = Date.now() - inicioIndice;

  const linhaPorIndice = new Map(candidatos.map((c) => [c.indice, c.linha]));
  const pagina = resultados.slice(desde);

  const eventos: LinhaResultado[] = [];
  let proximoCursor: number | null = null;
  let tamanho = 2; // '[]'

  for (let posicao = 0; posicao < pagina.length; posicao++) {
    const item = pagina[posicao]!;
    const evento: LinhaResultado = { ...linhaPorIndice.get(item.indice)!, relevancia: item.relevancia };
    const incremento = JSON.stringify(evento).length + (eventos.length > 0 ? 1 : 0);

    if (eventos.length > 0 && tamanho + incremento > TETO_PAGINA_CHARS) {
      proximoCursor = desde + posicao;
      break;
    }

    tamanho += incremento;
    eventos.push(evento);
    if (eventos.length >= limite) {
      proximoCursor = desde + posicao + 1 < resultados.length ? desde + posicao + 1 : null;
      break;
    }
  }

  return {
    saida: { modo: 'busca', eventos, combinacao, ate: limiteAte, linhasInvalidas: linhasInvalidas.slice(0, 100), proximoCursor },
    extra: { modo: 'busca', candidatos: candidatos.length, msIndice, combinacao },
  };
}

// ---- cadeia ----

function resolverCadeia(ctx: Contexto, { projeto, processo }: { projeto: string; processo: string }): Cadeia {
  const carregado = carregarProcesso(ctx.dirDados, projeto, processo);
  const texto = lerTexto(carregado.arquivoEventos);
  return verificarCadeia(texto, carregado.manifesto, validarDadosDoProcesso(carregado.esquemasCustom));
}
