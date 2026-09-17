import type { z } from 'zod';

/** Um item do array `detalhes` de `ErroHexlog` (§4.13): aponta o campo problemático via JSON Pointer. */
export type Detalhe = {
  caminho: string;
  codigo: string;
  mensagem: string;
};

/** Catálogo de códigos de erro de domínio (§4.13). */
export type CodigoErro =
  | 'ENTRADA_INVALIDA'
  | 'FILTRO_INVALIDO'
  | 'NOME_RESERVADO'
  | 'SCHEMA_INVALIDO'
  | 'PROJETO_INEXISTENTE'
  | 'PROCESSO_INEXISTENTE'
  | 'TIPO_INEXISTENTE'
  | 'PROCESSO_JA_EXISTE'
  | 'VOCABULARIO_AUSENTE'
  | 'PROCESSO_CORROMPIDO'
  | 'ID_INVALIDO'
  | 'ID_DESCONHECIDO'
  | 'ID_CONFLITANTE'
  | 'TIPO_NAO_FIXADO'
  | 'EVENTO_INVALIDO'
  | 'CAMPO_RESERVADO'
  | 'VOCABULARIO_VIOLADO'
  | 'GATE_NAO_REGISTRADO'
  | 'AVALIACAO_INVALIDA'
  | 'LOCK_TIMEOUT'
  | 'LOCK_PERDIDO'
  | 'ERRO_IO'
  | 'INTERNO';

/** Erro de domínio do hexlog: todo handler MCP captura este tipo e devolve `{codigo, mensagem, detalhes}` (§4.13). */
export class ErroHexlog extends Error {
  readonly codigo: CodigoErro;
  readonly detalhes: Detalhe[];

  constructor(codigo: CodigoErro, mensagem: string, detalhes: Detalhe[] = []) {
    super(mensagem);
    this.name = 'ErroHexlog';
    this.codigo = codigo;
    this.detalhes = detalhes;
  }
}

/** JSON Pointer (RFC 6901) de um `path` do Zod, escapando `~` e `/` na ordem correta. */
export function ponteiro(path: PropertyKey[]): string {
  return path.map((segmento) => `/${String(segmento).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/** Converte `issues` do Zod em `detalhes[]`, prefixando o ponteiro (ex.: `/dados`). */
export function detalhesDeIssues(issues: z.core.$ZodIssue[], prefixo: string): Detalhe[] {
  return issues.map((issue) => ({
    caminho: prefixo + ponteiro(issue.path),
    codigo: issue.code,
    mensagem: issue.message,
  }));
}
