export const GIT_SHA_FORMAT = 'git-sha';

/** Hexadecimal minúsculo de 7 a 40 caracteres; sem normalizar e sem conferir se o commit existe. */
const GIT_SHA = /^[0-9a-f]{7,40}$/;

export const isGitSha = (value: string): boolean => GIT_SHA.test(value);

/** Formatos que o hexlog registra no validador além dos do `ajv-formats`; lista fechada. */
export const FORMAT_CATALOG: Readonly<Record<string, (value: string) => boolean>> = {
  [GIT_SHA_FORMAT]: isGitSha,
};

export const catalogNames = (): string[] => Object.keys(FORMAT_CATALOG);
