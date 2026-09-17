import canonicalize from 'canonicalize';
import { isNil } from 'es-toolkit';
import { get } from 'es-toolkit/compat';
import { z } from 'zod';
import { detalhesDeIssues, ErroHexlog } from './errors.ts';

// §4.2: regex única de nome para projeto, processo, tipo, gate e dono.
const NOME_SRC = '[a-z0-9][a-z0-9-]{0,62}';
const NOME_RE = new RegExp(`^${NOME_SRC}$`);
export const Nome = z.string().regex(NOME_RE);

// §4.3: prefixo do id (sem uuid) × id completo (com uuid v7).
const UUID_V7_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ID_RE = new RegExp(`^(${NOME_SRC}):(${NOME_SRC}):(${NOME_SRC})(?::(${UUID_V7_SRC}))?$`);
export const ID_COMPLETO_RE = new RegExp(
  `^(${NOME_SRC}):(${NOME_SRC}):(${NOME_SRC}):(${UUID_V7_SRC})$`,
);

export const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const Instante = z.iso.datetime();
export const Agente = z.string().min(1).max(100);
export const Rotulo = z.string().min(1).max(200);
export const Texto = z.string().min(1).max(4000);
const IdCompleto = z.string().regex(ID_COMPLETO_RE);

// Endereço de alvo: só o serviço 'alvo' (§4.3), sem espaço nem ':' no id.
export const Alvo = z
  .string()
  .max(200)
  .regex(/^hex:alvo:[^\s:]+$/);

/** Decompõe um id de evento em `{projeto, processo, tipo, uuid?}`, ou `null` se não casar §4.3. */
export function analisarId(
  id: string,
): { projeto: string; processo: string; tipo: string; uuid?: string } | null {
  const casamento = ID_RE.exec(id);
  if (isNil(casamento)) return null;
  const [, projeto, processo, tipo, uuid] = casamento;
  return isNil(uuid) ? { projeto, processo, tipo } : { projeto, processo, tipo, uuid };
}

export const Linha = z.strictObject({
  seq: z.number().int().min(0),
  id: z.string(),
  tipo: Nome,
  timestamp: Instante,
  agente: Agente,
  prevHash: Hash,
  dados: z.record(z.string(), z.unknown()),
});
export type Linha = z.infer<typeof Linha>;

const DadosMarco = z.strictObject({
  marcoTipo: Rotulo,
  alvo: Alvo,
  contagem: z.strictObject({ campo: Rotulo, valor: z.number() }).optional(),
  prazoExecucao: z.iso.datetime({ offset: true }).optional(),
  decisoes: z
    .array(z.strictObject({ item: Rotulo, acao: Rotulo, texto: Texto }))
    .max(100)
    .optional(),
});

const DadosVeredito = z.strictObject({
  afirmacao: Texto,
  fonte: Texto,
  resultado: Rotulo,
  prova: z.union([Texto, z.array(Texto).min(1).max(20)]),
  destino: Alvo,
  supera: z.array(IdCompleto).min(1).max(100).optional(),
  origem: Texto,
  rastro: Texto,
});

export const DadosMarcoGate = z.strictObject({
  marcoTipo: z.literal('gate'),
  alvo: Alvo,
  gate: z.strictObject({
    nome: Nome,
    origem: z.enum(['embutido', 'custom']),
    criterio: z.string().max(2000),
    passou: z.boolean(),
    prova: z.array(z.unknown()).max(50),
    totalItensProva: z.number().int().min(0),
    avaliadoAte: z
      .strictObject({ id: z.string(), seq: z.number().int(), timestamp: Instante })
      .nullable(),
  }),
});

/** Teto de caracteres canônicos (JCS) para `dados` de um evento (§4.4). */
const TETO_DADOS_CHARS = 16_000;

/**
 * Escolhe o schema de `dados` para `tipo`: nativos fixos (Marco/Veredito, com o desvio
 * para `DadosMarcoGate` quando `marcoTipo === 'gate'`) ou o Zod já convertido do snapshot
 * do processo, recebido em `esquemasCustom` (já convertido de JSON Schema por `carregarProcesso`).
 */
export function esquemaDados(
  tipo: string,
  dados: unknown,
  esquemasCustom: Record<string, z.ZodType>,
): z.ZodType {
  if (tipo === 'marco') {
    return get(dados, 'marcoTipo') === 'gate' ? DadosMarcoGate : DadosMarco;
  }
  if (tipo === 'veredito') return DadosVeredito;
  return esquemasCustom[tipo];
}

/**
 * Normaliza `dados` de um evento: parse estrito (com `default` aplicado pelo próprio Zod)
 * e `prazoExecucao` convertido para UTC `Z`. Usada tanto na escrita quanto na retentativa
 * por id completo (mesma função, para a comparação de idempotência de N2 bater).
 */
export function normalizarDados(
  tipo: string,
  dados: unknown,
  esquemasCustom: Record<string, z.ZodType> = {},
): Record<string, unknown> {
  const esquema = esquemaDados(tipo, dados, esquemasCustom);
  const resultado = esquema.safeParse(dados);
  if (!resultado.success) {
    throw new ErroHexlog(
      'EVENTO_INVALIDO',
      'dados do evento reprovados na validação',
      detalhesDeIssues(resultado.error.issues, '/dados'),
    );
  }

  const normalizado = aplicarPrazoUtc(resultado.data as Record<string, unknown>);
  // canonicalize só devolve undefined para entradas não serializáveis; `normalizado` é
  // sempre um objeto simples pós-parse do Zod.
  const tamanho = (canonicalize(normalizado) ?? '').length;
  if (tamanho > TETO_DADOS_CHARS) {
    throw new ErroHexlog(
      'EVENTO_INVALIDO',
      `dados excedem ${TETO_DADOS_CHARS} caracteres canônicos`,
      [{ caminho: '/dados', codigo: 'too_big', mensagem: `tamanho canônico ${tamanho}` }],
    );
  }
  return normalizado;
}

function aplicarPrazoUtc(dados: Record<string, unknown>): Record<string, unknown> {
  if (isNil(dados.prazoExecucao)) return dados;
  return { ...dados, prazoExecucao: new Date(dados.prazoExecucao as string).toISOString() };
}
