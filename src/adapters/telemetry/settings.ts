import { isUndefined } from 'es-toolkit';

export type TelemetrySettings = { endpoint: string; headers: Record<string, string> };

const decode = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/;

/**
 * `k=v` dividido no primeiro `=`; chave e valor percent-decodificados; par malformado, nome que não
 * é token HTTP ou valor com CR, LF ou NUL vira nada (senão só falharia no envio, sem causa clara).
 */
const parsePair = (pair: string): [string, string][] => {
  const separator = pair.indexOf('=');
  if (separator < 1) return [];
  const key = decode(pair.slice(0, separator).trim());
  const value = decode(pair.slice(separator + 1).trim());
  if (isUndefined(key) || isUndefined(value)) return [];
  return HEADER_NAME.test(key) && !HEADER_VALUE_FORBIDDEN.test(value) ? [[key, value]] : [];
};

/**
 * Lê só `HEXLOG_OTEL_ENDPOINT` e `HEXLOG_OTEL_HEADERS`; qualquer outra variável é ignorada.
 * Endpoint ausente ou vazio desliga a telemetria.
 */
export function readTelemetrySettings(
  env: Record<string, string | undefined>,
): TelemetrySettings | undefined {
  const endpoint = env.HEXLOG_OTEL_ENDPOINT?.trim();
  if (isUndefined(endpoint) || endpoint.length === 0) return undefined;

  const pairs = (env.HEXLOG_OTEL_HEADERS ?? '').split(',').flatMap(parsePair);
  // `fromEntries` cria propriedade própria mesmo para a chave `__proto__`.
  return { endpoint, headers: Object.fromEntries(pairs) };
}
