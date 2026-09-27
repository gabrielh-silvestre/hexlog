import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

const VALID_HOOK_TRUE = `---
phases: [design]
process:
  design: design
skills:
  design: [my-skill]
hook: true
---
`;

const VALID_HOOK_FALSE = `---
phases: [design]
process:
  design: design
hook: false
---
`;

/** Cria um repo temporário e, se `content` for passado, grava `.hexlog/flow.md` nele. */
function repoWithFlowMap(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-flow-reminder-repo-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(dir, '.hexlog'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.hexlog', 'flow.md'), content);
  }
  return dir;
}

function payload(cwd: unknown, skill: string): string {
  return JSON.stringify({ tool_name: 'Skill', tool_input: { skill }, cwd });
}

describe('flow-reminder hook (passo 3)', () => {
  let outdir: string;
  let bundlePath: string;

  beforeAll(() => {
    outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-flow-reminder-build-'));
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'test/fixtures/build-flow-reminder.ts'), outdir],
      { encoding: 'utf8', cwd: repoRoot },
    );
    if (result.status !== 0) {
      throw new Error(`flow-reminder build failed: ${result.stderr}`);
    }
    bundlePath = path.join(outdir, 'flow-reminder.mjs');
  }, 20_000);

  afterAll(() => {
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  function runHook(stdin: string): { status: number | null; stdout: string } {
    const result = spawnSync(process.execPath, [bundlePath], { input: stdin, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout };
  }

  /** Roda o hook contra um repo temporário com `content` (ou sem `.hexlog/flow.md`, se omitido)
   * invocando `skill`, e cobra exit 0 sem stdout — o caso comum aos 4 testes de "sem lembrete". */
  function expectNoReminder(content: string | undefined, skill: string): void {
    const cwd = repoWithFlowMap(content);
    try {
      const { status, stdout } = runHook(payload(cwd, skill));
      expect(status).toBe(0);
      expect(stdout).toBe('');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  test('.hexlog/flow.md ausente → exit 0 sem stdout', () => {
    expectNoReminder(undefined, 'my-skill');
  });

  test('.hexlog/flow.md presente mas parseFlowMap inválido → exit 0 sem stdout', () => {
    expectNoReminder('not a frontmatter block at all', 'my-skill');
  });

  test('frontmatter válido com hook: false → exit 0 sem stdout', () => {
    expectNoReminder(VALID_HOOK_FALSE, 'my-skill');
  });

  test('hook: true mas skill invocada não mapeada em nenhuma fase → exit 0 sem stdout', () => {
    expectNoReminder(VALID_HOOK_TRUE, 'other-skill');
  });

  test('hook: true, skill mapeada numa fase → additionalContext citando fase e process', () => {
    const cwd = repoWithFlowMap(VALID_HOOK_TRUE);
    try {
      const { status, stdout } = runHook(payload(cwd, 'my-skill'));
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('design');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('stdin malformado (JSON quebrado) → exit 0 sem stdout', () => {
    const { status, stdout } = runHook('not json {{{');
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  test('stdin sem tool_name → exit 0 sem stdout', () => {
    const cwd = repoWithFlowMap(VALID_HOOK_TRUE);
    try {
      const { status, stdout } = runHook(
        JSON.stringify({ tool_input: { skill: 'my-skill' }, cwd }),
      );
      expect(status).toBe(0);
      expect(stdout).toBe('');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('exceção interna forçada (cwd com caractere inválido) → exit 0 sem stdout', () => {
    const { status, stdout } = runHook(payload('bad\u0000path', 'my-skill'));
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  test('--validate com fixture inválida → exit 1 com issues no stdout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-flow-validate-'));
    const invalidFile = path.join(dir, 'flow.md');
    try {
      fs.writeFileSync(invalidFile, 'not a frontmatter block at all');
      const result = spawnSync(process.execPath, [bundlePath, '--validate', invalidFile], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stdout.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--validate com fixture válida → exit 0 sem issues', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-flow-validate-'));
    const validFile = path.join(dir, 'flow.md');
    try {
      fs.writeFileSync(validFile, VALID_HOOK_TRUE);
      const result = spawnSync(process.execPath, [bundlePath, '--validate', validFile], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
