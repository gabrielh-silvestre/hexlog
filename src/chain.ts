import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { isNil, isNotNil, omit } from 'es-toolkit';
import { get } from 'es-toolkit/compat';
import { z } from 'zod';
import type { Detail } from './errors.ts';
import { EventLine, Hash } from './events.ts';

// §4.6: tetos de saída da verificação de cadeia, usados pelos schemas abaixo e por `verifyChain`.
const MAX_BREAKS = 100;
const MAX_REPAIRED = 100;

/** Elo quebrado da cadeia (§4.6): schema Zod é a fonte única, mcp.ts só reexporta. */
export const Break = z.object({
  index: z.number().int(),
  reason: z.enum([
    'invalid-line',
    'diverging-seq',
    'hash-mismatch',
    'invalid-data',
    'attachment-missing',
    'attachment-corrupted',
  ]),
  detail: z.string().optional(),
});
export type Break = z.infer<typeof Break>;

/** Resultado de `verifyChain` (§4.6): schema Zod é a fonte única, mcp.ts só reexporta. */
export const Chain = z.object({
  ok: z.boolean(),
  totalLines: z.number().int(),
  head: z.union([z.literal(''), Hash]),
  breaks: z.array(Break).max(MAX_BREAKS),
  totalBreaks: z.number().int(),
  repairedLines: z.array(z.number().int()).max(MAX_REPAIRED),
});
export type Chain = z.infer<typeof Chain>;

export function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `hashLine(l) = sha256hex(l.prevHash + canonicalize(omit(l, 'prevHash')))` (JCS, §4.6). */
export function hashLine(l: EventLine): string {
  return sha256hex(l.prevHash + jcs(omit(l, ['prevHash'])));
}

/** `anchor(manifest) = sha256hex(canonicalize(manifest))`: raiz da cadeia de um processo. */
export function anchor(manifest: unknown): string {
  return sha256hex(jcs(manifest));
}

// canonicalize devolve `string | undefined` só para entradas não serializáveis (function,
// symbol, undefined); EventLine e o manifesto nunca são isso, mas o tipo exige o fallback.
function jcs(value: unknown): string {
  return canonicalize(value) ?? '';
}

/** Predicado único (escritor e verificador): a linha é um elo válido, ou `null`. */
export function isValidLink(text: string): EventLine | null {
  try {
    const result = EventLine.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** `prevHash` esperado do próximo elo, dado o último elo válido anterior (ou `null` = início da cadeia). */
export function expectedPrevHash(lastLink: EventLine | null, manifest: unknown): string {
  return isNil(lastLink) ? anchor(manifest) : hashLine(lastLink);
}

/** `seq` esperado do próximo elo: `n` = linhas não-elo (pendentes) desde o último elo (ou desde o início). */
export function nextSeq(lastLink: EventLine | null, n: number): number {
  return isNil(lastLink) ? n : lastLink.seq + 1 + n;
}

/** Estado de um anexo já verificado no disco pelo chamador (`attachments.ts`); `chain.ts` não faz I/O. */
export type AttachmentStatus = 'ok' | 'missing' | 'corrupted';

/** `data.attachment` quando é um hash; `attachment` é o nome reservado por convenção para a referência de blob. */
function attachmentHashOf(data: Record<string, unknown>): string | undefined {
  return Hash.safeParse(data.attachment).success ? (data.attachment as string) : undefined;
}

/**
 * Hashes de `data.attachment` dos elos de `text` cujo tipo declara `properties.attachment` no
 * snapshot fixado do processo. Puro: quem chama consulta o disco só para esses hashes.
 */
export function attachmentRefs(
  text: string,
  manifest: { fixed: { types: Record<string, object> } },
): string[] {
  const declaring = new Set(
    Object.entries(manifest.fixed.types)
      .filter(([, schema]) => isNotNil(get(schema, 'properties.attachment')))
      .map(([type]) => type),
  );
  if (declaring.size === 0) return [];

  const hashes = new Set<string>();
  for (const line of text.split('\n').slice(0, -1)) {
    const link = isValidLink(line);
    const hash = isNil(link) || !declaring.has(link.type) ? undefined : attachmentHashOf(link.data);
    if (isNotNil(hash)) hashes.add(hash);
  }
  return [...hashes];
}

/**
 * Verifica a cadeia de hash de um log JSONL (§4.6). `validateData`, quando informado, roda
 * sobre `{type, data}` de cada elo e retorna `Detail[]` (reprovado) ou `null` (aprovado);
 * um retorno não nulo vira quebra `invalid-data`. `attachments`, quando informado, mapeia hash de
 * anexo para o estado já verificado: elo cujo `data.attachment` está no mapa e não é `ok` vira
 * quebra `attachment-missing`/`attachment-corrupted`; hash fora do mapa não é checado.
 */
export function verifyChain(
  text: string,
  manifest: unknown,
  validateData?: (type: string, data: Record<string, unknown>) => Detail[] | null,
  attachments?: ReadonlyMap<string, AttachmentStatus>,
): Chain {
  // A cauda sem '\n' (escrita em andamento, ou rasgo ainda não reparado) é ignorada:
  // split(-1) descarta o último elemento, terminado ou não.
  const lines = text.split('\n').slice(0, -1);

  let lastLink: EventLine | null = null;
  let pending: number[] = [];
  const breaks: Break[] = [];
  const repairedLines: number[] = [];

  const resolvePending = (repair: boolean) => {
    if (repair) {
      repairedLines.push(...pending);
    } else {
      for (const index of pending) breaks.push({ index, reason: 'invalid-line' });
    }
    pending = [];
  };

  lines.forEach((line, index) => {
    const link = isValidLink(line);
    if (isNil(link)) {
      pending.push(index);
      return;
    }

    const seqOk = link.seq === nextSeq(lastLink, pending.length);
    const hashOk = link.prevHash === expectedPrevHash(lastLink, manifest);
    if (!seqOk) breaks.push({ index, reason: 'diverging-seq' });
    if (!hashOk) breaks.push({ index, reason: 'hash-mismatch' });
    resolvePending(seqOk && hashOk);

    if (isNotNil(validateData) && isNotNil(validateData(link.type, link.data))) {
      breaks.push({ index, reason: 'invalid-data' });
    }
    const hash = attachmentHashOf(link.data);
    const attachment = isNil(hash) ? undefined : attachments?.get(hash);
    if (isNotNil(attachment) && attachment !== 'ok') {
      breaks.push({ index, reason: `attachment-${attachment}`, detail: hash });
    }

    lastLink = link;
  });
  resolvePending(false);

  breaks.sort((a, b) => a.index - b.index);

  return {
    ok: breaks.length === 0,
    totalLines: lines.length,
    head: isNil(lastLink) ? '' : hashLine(lastLink),
    breaks: breaks.slice(0, MAX_BREAKS),
    totalBreaks: breaks.length,
    repairedLines: repairedLines.slice(0, MAX_REPAIRED),
  };
}
