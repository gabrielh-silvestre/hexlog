import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { createTempDir, parseJson } from './helpers.ts';

export const repoRoot = path.resolve(__dirname, '..');
const installScript = path.join(repoRoot, 'scripts/install.ts');

// Equivalente mínimo de `own-harness/boot/settings.template.json`
// renderizado: uma reinstalação do zero, sem nada do hexlog nem do rtk.
export function buildSettingsTemplate(home: string): string {
  return `{
  "permissions": {
    "allow": ["mcp__hindsight__*"],
    "deny": ["mcp__gitnexus__cypher", "mcp__gitnexus__rename"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Agent$",
        "hooks": [{ "type": "command", "command": "${home}/.claude/bin/harness hook agent-concurrency-guard" }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": "${home}/.claude/bin/harness hook worktree-guard" },
          { "type": "command", "command": "${home}/.claude/bin/harness hook commit-message-guard" }
        ]
      }
    ]
  }
}
`;
}

const DenySchema = z.object({ permissions: z.object({ deny: z.array(z.string()) }) });

/** As regras de `permissions.deny` do texto de `settings.json`. */
export const denyOf = (text: string): string[] => parseJson(DenySchema, text).permissions.deny;

/** Versão de `package.json`: a que o instalador grava. */
export function packageVersion(): string {
  return parseJson(
    z.looseObject({ version: z.string() }),
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ).version;
}

/** Roda `scripts/install.ts` como processo real, com `HOME` e `<D>` (via `XDG_DATA_HOME`) descartáveis. */
export function runInstaller(home: string, D: string, args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [installScript, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: path.dirname(D),
      HEXLOG_REGISTER_MCP: path.join(repoRoot, 'test/fixtures/fake-mcp-install.ts'),
    },
  });
}

// `<D>` fica sob o XDG_DATA_HOME fixado no HOME temporário: nunca o dado real do usuário.
export function createInstallHome(prefix: string): { home: string; D: string } {
  const home = createTempDir(prefix);
  return { home, D: path.join(home, '.local', 'share', 'hexlog') };
}

/** Instala o baseline real (processo) num HOME descartável: o `--check` e o `verifyInstallation` partem dele. */
export function installBaseline(): { home: string; D: string; version: string } {
  // Fixa o <D> no HOME temporário: um XDG_DATA_HOME herdado com dado 0.x faria o instalador sair 2.
  const { home, D } = createInstallHome('install-baseline');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), buildSettingsTemplate(home));

  const installation = runInstaller(home, D, []);
  if (installation.status !== 0) {
    throw new Error(
      `real baseline installation failed: ${installation.stderr}\n${installation.stdout}`,
    );
  }
  return { home, D, version: packageVersion() };
}

/**
 * Aponta `HOME` (e tira `XDG_DATA_HOME`) para `home` no processo de teste e devolve o restore.
 * `runRealHook` roda o hook num processo filho que herda `process.env` (o mesmo contrato de
 * produção, onde o instalador roda como o usuário real): para `D` bater com o que o hook calcula,
 * o `HOME` do processo de teste precisa apontar para o `HOME` temporário.
 */
export function useHome(home: string): () => void {
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_DATA_HOME;
  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME;
  return () => {
    process.env.HOME = originalHome;
    if (originalXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdg;
    }
  };
}
