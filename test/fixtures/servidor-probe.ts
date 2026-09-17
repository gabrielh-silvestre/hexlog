// Entrypoint de probe para o bundle do esbuild (sub-passo 6b): um McpServer
// stdio mínimo, com 1 tool, que importa as deps de runtime do servidor real
// (§2.2) para verificar que o bundle não tem `Dynamic require of`.
// `jsonc-parser` fica de fora: é dependência só do instalador (§2.2 linha 125),
// que roda sem build a partir da working tree, nunca entra no bundle do servidor.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { quote } from 'shell-quote';
import canonicalize from 'canonicalize';
import { pick } from 'es-toolkit';
import { get } from 'es-toolkit/compat';
import MiniSearch from 'minisearch';
import { randomUUIDv7 } from 'node:crypto';

const ajv = new Ajv2020.default({ strict: true });
addFormats.default(ajv);

const indice = new MiniSearch({ fields: ['texto'] });
indice.addAll([{ id: 1, texto: 'evento marco aprovado' }]);

serveStdio(() => {
  const servidor = new McpServer({ name: 'servidor-probe', version: '0.0.0' });

  servidor.registerTool(
    'eco',
    { description: 'devolve um diagnóstico das deps carregadas', inputSchema: { texto: z.string() } },
    async ({ texto }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            texto,
            ajvSchemaValido: ajv.validateSchema({ type: 'object' }),
            uuid: randomUUIDv7(),
            buscaMinisearch: indice.search('marco').map((resultado) => resultado.id),
            pick: pick({ a: 1, b: 2 }, ['a']),
            get: get({ a: { b: 1 } }, 'a.b'),
            canon: canonicalize({ b: 1, a: 2 }),
            shellQuote: quote(['echo', texto]),
          }),
        },
      ],
    }),
  );

  return servidor;
});
