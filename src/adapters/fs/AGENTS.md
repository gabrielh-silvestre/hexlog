# fs

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-07 · **Updated:** 2026-10-07

## Purpose

Adaptadores de disco do dado 1.0, sob `<D>/.v1/`: os três stores (`ProcessStore`, `DefinitionStore`, `AttachmentStore`) e a infraestrutura que eles compartilham (gravação atômica, lock por processo, formato em disco e helpers de I/O). Só Linux: `link` exclusivo, `fsync` de diretório e `/proc` são pressupostos.

## Key Files

| File | Description |
|------|-------------|
| `data-format.ts` | Única fonte dos nomes de pasta e arquivo do dado 1.0: `dataRoot`, `processPaths`, `definitionDir`, `definitionFile`, `attachmentsDir`, `blobFile`, as constantes `MANIFEST_FILE`, `LOG_FILE`, `LOCK_DIR`, `ATTACHMENTS_DIR`, `ARCHIVE_DIR`, `VERSION_SUFFIX`, e `LEGACY_NAME` com `detectLegacy` (detecção do dado 0.x). As funções recebem nomes já validados |
| `io.ts` | Helpers compartilhados pelos stores: `mapIo` e `toHexlogError` (errno vira `IO_ERROR` só com o código), `safeName` (valida nome antes de virar caminho), `orIfMissing`, `readIfPresent`, `existsStrict` (só `ENOENT` vale ausente) e `listDirectories` |
| `atomic.ts` | Escrita durável: `writeFileAtomic` (temporário, `fsync`, depois `rename` ou `link` exclusivo), `writeSynced`, `fsyncPath`, `errnoCode` e `isDirectoryTaken` |
| `lock.ts` | `createLockManager` (`acquire`, `confirm`, `release`): lock por processo em diretório, dono identificado por pid, `bootId` e token; órfão é roubado, dono vivo nunca. Também exporta `moveAside` e `isPidAlive` |
| `process-store.ts` | `createProcessStore`: `ProcessStore` sobre `<projeto>/<processo>/{process.json,records.jsonl}`; `write` roda sob o lock com um `fsync` por lote e `MAX_LOG_BYTES` limita o log (`PROCESS_TOO_LARGE`); também lista processos e projetos e lê só o manifesto |
| `definition-store.ts` | `createDefinitionStore`: `DefinitionStore` sobre `<projeto>/{types,relations,gates}/<nome>/<major>.<minor>.json`; versão gravada por `link` exclusivo e nunca sobrescrita, definição inválida é recusada antes de gravar |
| `attachment-store.ts` | `createAttachmentStore`: `AttachmentStore` sobre `<projeto>/attachments/<sha256>`; blob imutável com teto `ATTACHMENT_MAX_BYTES`, `putPath` só dentro do `cwd` injetado e fora de `<D>`, memo de verificação por impressão do arquivo |

## Dependencies

### Internal

- `../../ports.ts`: as portas implementadas
- `../../domain/`: `Name`, `Hash`, `Manifest`, definições e `sha256hex`
- `../../errors.ts`: `HexlogError` e os construtores de erro
- `../../shared/logger.ts`: `Logger`, usado por `lock.ts`
- Importados de fora desta pasta: `compose.ts` (os três stores e `detectLegacy`), `archive.ts` (`errnoCode`, `fsyncPath`, `isDirectoryTaken`, `orIfMissing`, `readIfPresent`, `ARCHIVE_DIR`, `detectLegacy`, `isPidAlive`) e `installation.ts` (`errnoCode`, `isDirectoryTaken`, `writeFileAtomic`, `orIfMissing`, `readIfPresent`)

### External

- `node:fs` (import padrão, não `import * as fs`), `node:path`, `node:crypto`, `node:buffer`, `node:timers/promises`
- `es-toolkit`, `zod`

## Manual Notes

## Diretrizes

- [convencoes.md](../../../docs/directives/convencoes.md): escrita em disco por `writeFileAtomic` e import padrão de `fs`
- [invariantes.md](../../../docs/directives/invariantes.md): log append-only, lock por processo, anexos imutáveis e definições versionadas
