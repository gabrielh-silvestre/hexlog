import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Hash, Name } from '../../domain/ids.ts';
import {
  advertise,
  execute,
  PAGE_CHARS_CAP,
  READ_ANNOTATIONS,
  type ToolDeps,
  WRITE_ANNOTATIONS,
} from '../kernel.ts';

// D-15: os dois são opcionais aqui, sem união; o serviço exige exatamente um.
const Attach = z.strictObject({
  project: Name,
  text: z.string().optional().describe('Attachment content. Send this or `path`, never both.'),
  path: z
    .string()
    .optional()
    .describe('A .md or .txt file inside the server cwd. Send this or `text`, never both.'),
});

const Attached = z.object({ hash: Hash, bytes: z.number(), deduplicated: z.boolean() });

// N11: `.int()` e os pisos recusam a entrada na borda, com `INVALID_INPUT` e `details[].path`.
const ReadAttachment = z.strictObject({
  project: Name,
  hash: Hash,
  offset: z.number().int().min(0).optional().describe('Character position; the previous `next`.'),
  maxChars: z.number().int().min(1).max(PAGE_CHARS_CAP).optional(),
});

const AttachmentPage = z.object({
  text: z.string(),
  next: z.number().optional(),
  status: z.literal('ok'),
});

/** Registra `attach` e `read_attachment`: blobs de texto imutáveis endereçados pelo sha256. */
export function registerAttachmentTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'attach',
    {
      title: 'Attach',
      description:
        'Stores a text as an immutable attachment of the project and returns its sha256 `hash`, ' +
        'the `bytes` size and whether it already existed (`deduplicated`). Send exactly one of ' +
        '`text` or `path`. Records point to an attachment by hash, in a property declared with ' +
        '`format: "attachment"`; read it back with `read_attachment`.',
      inputSchema: advertise(Attach),
      outputSchema: Attached,
      annotations: WRITE_ANNOTATIONS,
    },
    (args, ctx) =>
      execute(deps, { name: 'attach', schema: Attach, args, ctx }, (input) =>
        deps.services.attachment.attach(input),
      ),
  );

  server.registerTool(
    'read_attachment',
    {
      title: 'Read attachment',
      description:
        'Reads one page of an attachment by hash. A longer text returns `next`, the `offset` of the ' +
        'following page; the last page has no `next`. A missing or corrupted attachment is an error.',
      inputSchema: advertise(ReadAttachment),
      outputSchema: AttachmentPage,
      annotations: READ_ANNOTATIONS,
    },
    (args, ctx) =>
      execute(deps, { name: 'read_attachment', schema: ReadAttachment, args, ctx }, (input) =>
        deps.services.query.readAttachment({
          ...input,
          maxChars: input.maxChars ?? PAGE_CHARS_CAP,
        }),
      ),
  );
}
