import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

// Helper dos specs de telemetria (não é spec): receptor HTTP local no lugar de um coletor OTLP, os
// tipos do que ele guarda e do corpo OTLP/JSON. Usado por `adapters/otel.spec.ts` e `stdio.e2e.spec.ts`.

export type Hit = {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
};

export type Receiver = { origin: string; hits: Hit[]; close: () => Promise<void> };

/** Os campos do corpo OTLP/JSON que os specs leem. */
export type OtlpBody = {
  resourceSpans?: { scopeSpans: { spans: { name: string }[] }[] }[];
  resourceMetrics?: {
    scopeMetrics: {
      metrics: {
        name: string;
        sum?: {
          aggregationTemporality: number;
          dataPoints: { asInt?: string | number; asDouble?: number }[];
        };
      }[];
    }[];
  }[];
};

/** Receptor local: `ok` responde 200 a tudo; `mute` aceita a conexão e nunca responde. */
export async function listen(behavior: 'ok' | 'mute' = 'ok'): Promise<Receiver> {
  const hits: Hit[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      hits.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (behavior === 'ok')
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
