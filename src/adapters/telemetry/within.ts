/**
 * Espera `work` por no máximo `ms` e nunca rejeita: uma etapa de encerramento que falha ou não
 * termina não pode segurar quem encerra. O timer é sempre limpo.
 */
export async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work.catch(() => undefined), expired]);
  } finally {
    clearTimeout(timer);
  }
}
