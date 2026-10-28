import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { compose } from '../../src/compose.ts';
import { BatchKey } from '../../src/domain/chain.ts';
import { Name } from '../../src/domain/ids.ts';
import { Author, type BatchItem } from '../../src/domain/record.ts';
import { legacyDataError } from '../../src/errors.ts';
import { VERSION } from '../../src/version.ts';

const INSTALL = 'run node scripts/install.ts';

// Só os campos que a trava lê de `InstallManifest` (`src/installation.ts`); o resto do manifesto não importa.
const Manifest = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  dirty: z.boolean(),
});

const ClaudeJson = z.object({
  mcpServers: z.object({ hexlog: z.object({ args: z.tuple([z.string()], z.unknown()) }) }),
});

export type DiffResult = 'same' | 'differs' | 'error';

type InstalledCheck = {
  /** `VERSION` de `src/version.ts`: a versão do repositório em que o script roda. */
  version: string;
  /** Texto de `~/.claude.json`, ou `null` quando o arquivo não existe ou não pôde ser lido. */
  claudeJsonText: string | null;
  /** Texto do `manifest.json` da pasta da versão instalada, ou `null` quando ausente. */
  readManifest: (versionDir: string) => string | null;
  gitDiffQuiet: (commit: string) => DiffResult;
};

/**
 * Confere que o servidor que as sessões executam é o código deste repositório: pasta da versão
 * igual a `version`, manifesto de build limpo e `src/` do `HEAD` igual ao do commit instalado.
 * Devolve os problemas, cada um com o remédio; lista vazia quer dizer código igual.
 */
export function checkInstalled({
  version,
  claudeJsonText,
  readManifest,
  gitDiffQuiet: diffSrc,
}: InstalledCheck): string[] {
  // Texto ausente ou que não é JSON fica `undefined`: o `safeParse` seguinte já o recusa.
  let claudeJson: unknown;
  try {
    claudeJson = JSON.parse(claudeJsonText ?? '');
  } catch {
    claudeJson = undefined;
  }
  const parsed = ClaudeJson.safeParse(claudeJson);
  if (!parsed.success) {
    return [`hexlog server not registered in ~/.claude.json: ${INSTALL}`];
  }
  const versionDir = path.dirname(parsed.data.mcpServers.hexlog.args[0]);
  const problems: string[] = [];

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(readManifest(versionDir) ?? '');
  } catch {
    manifestJson = undefined;
  }
  const manifest = Manifest.safeParse(manifestJson);
  if (!manifest.success) {
    problems.push(`manifest.json missing or invalid in ${versionDir}: ${INSTALL}`);
  }
  if (
    path.basename(versionDir) !== version ||
    (manifest.success && manifest.data.version !== version)
  ) {
    problems.push(`installed server is not version ${version} (${versionDir}): ${INSTALL}`);
  }
  if (!manifest.success) return problems;

  const { commit, dirty } = manifest.data;
  if (dirty || commit === null) {
    // O instalador devolve `none` e mantém o manifesto antigo quando os bytes dos bundles são iguais.
    problems.push(
      `installed build has a dirty tree or an unknown commit: with a clean tree at the wanted commit, move ${versionDir} aside and ${INSTALL}`,
    );
    return problems;
  }
  const diff = diffSrc(commit);
  if (diff === 'differs') {
    problems.push(`src/ differs from the installed commit ${commit}: ${INSTALL}`);
  } else if (diff === 'error') {
    problems.push(
      `cannot compare src/ with the installed commit ${commit} (unknown in this clone, or git failed): ${INSTALL}`,
    );
  }
  return problems;
}

/**
 * Adaptador real do `gitDiffQuiet` de `checkInstalled`, preso a `root` (a raiz do checkout):
 * `-C` e `:(top)` tornam o resultado independente do `cwd`; com pathspec relativo, rodar dentro
 * de `scripts/` dava "igual" falso, e um pathspec inexistente sai 0.
 */
export function gitDiffQuiet(root: string): (commit: string) => DiffResult {
  return (commit) => {
    // O commit vem de um arquivo que o script não controla: só hexadecimal, para nunca virar opção do git.
    if (!/^[0-9a-f]{4,64}$/i.test(commit)) return 'error';
    const { status } = spawnSync(
      'git',
      ['-C', root, 'diff', '--quiet', commit, 'HEAD', '--', ':(top)src/'],
      { stdio: 'ignore' },
    );
    if (status === 0) return 'same';
    return status === 1 ? 'differs' : 'error';
  };
}

/**
 * Entradas reais de `checkInstalled` (`~/.claude.json`, `manifest.json` da pasta instalada, `git`),
 * com `root` a raiz do checkout que a trava compara com o commit do build.
 */
export function readInstalled(root: string): InstalledCheck {
  return {
    version: VERSION,
    // Arquivo ausente ou ilegível vira `null`, que `checkInstalled` relata como problema.
    claudeJsonText: (() => {
      try {
        return fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
      } catch {
        return null;
      }
    })(),
    readManifest: (versionDir: string) => {
      try {
        return fs.readFileSync(path.join(versionDir, 'manifest.json'), 'utf8');
      } catch {
        return null;
      }
    },
    gitDiffQuiet: gitDiffQuiet(root),
  };
}

type WriteBatch = { process: string; key: string; records: readonly BatchItem[] };

/**
 * Gravador do log pelo `register` do `compose()`: o mesmo caminho do servidor (lock, cadeia, `key`).
 * Recusa antes de abrir se o código instalado não é o do repositório ou se o dado é 0.x. O serviço
 * não revalida `key` nem `Name`, então `write` os valida a cada lote.
 */
export function openWriter({
  dataDir,
  cwd,
  author,
  installed,
}: {
  dataDir: string;
  cwd: string;
  author: Author;
  installed: InstalledCheck;
}) {
  const problems = checkInstalled(installed);
  if (problems.length > 0) {
    throw new Error(`installed code check failed:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  const checkedAuthor = Author.parse(author);
  const { services, isLegacy } = compose({
    dataDir,
    cwd,
    clock: () => new Date(),
    logger: () => undefined,
  });
  if (isLegacy()) throw legacyDataError();

  const project = Name.parse('hexlog');

  return {
    write: async ({ process, key, records }: WriteBatch) =>
      services.process.register({
        project,
        process: Name.parse(process),
        author: checkedAuthor,
        key: BatchKey.parse(key),
        records,
      }),
    /** Anexa o `.md`/`.txt` de `file` (relativo ao `cwd` do writer) e devolve o hash do blob. */
    attach: (file: string) => services.attachment.attach({ project, path: file }).hash,
  };
}
