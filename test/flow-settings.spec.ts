import { beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MCP_UPDATE, repoRoot } from './flow-repo.ts';

type Hook = { type: string; command: string; if?: string };
type Entry = { matcher?: string; hooks: Hook[] };
type Settings = {
  hooks: Record<string, Entry[]>;
  permissions: { allow: string[]; ask: string[] };
};

const MCP_PR_MATCHER = '^mcp__github-official__(create|update)_pull_request$';

// o motor de permissões não roda no jest: o curinga vira regex só para provar o alcance
const permissionMatcher = (pattern: string): RegExp => {
  const inner = pattern.slice('Bash('.length, -1);
  return new RegExp(`^${inner.replaceAll('.', '\\.').replaceAll('*', '.*')}$`);
};

describe('.claude/settings.json', () => {
  let settings: Settings;

  const flowCommand = (mode: string): string =>
    `node "$CLAUDE_PROJECT_DIR/.claude/hooks/flow-hooks.ts" ${mode}`;

  const mcpPrHook = (): Hook | undefined =>
    (settings.hooks.PreToolUse ?? []).find((e) => e.matcher === MCP_PR_MATCHER)?.hooks[0];

  const bashPrHook = (): Hook | undefined =>
    (settings.hooks.PreToolUse ?? [])
      .filter((e) => e.matcher === 'Bash')
      .flatMap((e) => e.hooks)
      .find((h) => h.command.startsWith(flowCommand('pre-pr')));

  beforeAll(() => {
    settings = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.claude/settings.json'), 'utf8'),
    ) as Settings;
  });

  it('should have a SubagentStart entry with an empty matcher', () => {
    const entries = settings.hooks.SubagentStart ?? [];

    expect(entries).toHaveLength(1);
    expect(entries[0]?.matcher).toBe('');
    expect(entries[0]?.hooks[0]?.command).toBe(flowCommand('subagent-start'));
  });

  it('should end the MCP PR matcher command with || exit 2', () => {
    expect(mcpPrHook()?.command).toBe(`${flowCommand('pre-pr')} || exit 2`);
  });

  it('should exit the PR matcher command with 2 when PATH is empty', () => {
    const command = mcpPrHook()?.command ?? '';

    const result = spawnSync('/bin/sh', ['-c', command], {
      env: { PATH: '', CLAUDE_PROJECT_DIR: repoRoot },
      input: JSON.stringify({ tool_name: MCP_UPDATE, tool_input: { draft: true } }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
  }, 15_000);

  it('should end the Bash entry command with || exit 2', () => {
    expect(bashPrHook()?.command).toBe(`${flowCommand('pre-pr')} || exit 2`);
  });

  it('should set if Bash(gh *) on the Bash entry', () => {
    expect(bashPrHook()?.if).toBe('Bash(gh *)');
  });

  it('should exit the Bash matcher command with 2 when PATH is empty', () => {
    const result = spawnSync('/bin/sh', ['-c', bashPrHook()?.command ?? ''], {
      env: { PATH: '', CLAUDE_PROJECT_DIR: repoRoot },
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr create' } }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
  }, 15_000);

  it('should allow the commands of the flow scripts', () => {
    expect(settings.permissions.allow).toEqual([
      'Bash(node scripts/flow/flow.ts slug *)',
      'Bash(node scripts/flow/mark.ts *)',
      'Bash(node scripts/flow/sync-cli.ts check *)',
      'Bash(node scripts/flow/gate.ts *)',
      'Bash(node scripts/flow/report.ts *)',
      'Bash(node scripts/flow/critic.ts *)',
    ]);
  });

  it('should allow every verb of the critic runner without asking', () => {
    const pattern = 'Bash(node scripts/flow/critic.ts *)';
    const matcher = permissionMatcher(pattern);

    expect(settings.permissions.ask).not.toContain(pattern);
    expect(matcher.test('node scripts/flow/critic.ts start my-slug --tool agy')).toBe(true);
    expect(matcher.test('node scripts/flow/critic.ts ask /tmp/hexlog-critic-x-AbCdEf')).toBe(true);
    expect(matcher.test('node scripts/flow/critic.ts close /tmp/hexlog-critic-x-AbCdEf')).toBe(
      true,
    );
    expect(matcher.test('node scripts/flow/mark.ts my-slug')).toBe(false);
  });

  it('should not cite flow-report in any hooks command, since it is not a hook', () => {
    const commands = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );

    expect(commands.filter((command) => command.includes('flow-report'))).toEqual([]);
  });

  it('should ask before any install.ts invocation, flags included', () => {
    const pattern = 'Bash(node *scripts/install.ts*)';
    const matcher = permissionMatcher(pattern);

    expect(settings.permissions.ask).toContain(pattern);
    expect(matcher.test('node scripts/install.ts')).toBe(true);
    expect(matcher.test('node scripts/install.ts --archive-0x')).toBe(true);
    expect(matcher.test('node ./scripts/install.ts --check')).toBe(true);
    expect(matcher.test('node scripts/build.ts')).toBe(false);
  });

  it('should ask before reanchor.ts --apply and not before the dry-run', () => {
    const pattern = 'Bash(node *scripts/flow/reanchor.ts*--apply*)';
    const matcher = permissionMatcher(pattern);

    expect(settings.permissions.ask).toContain(pattern);
    expect(settings.permissions.allow).not.toContain(pattern);
    expect(matcher.test('node scripts/flow/reanchor.ts --to directives-4 --apply')).toBe(true);
    expect(matcher.test('node scripts/flow/reanchor.ts --apply --to directives-4')).toBe(true);
    expect(matcher.test('node ./scripts/flow/reanchor.ts --apply')).toBe(true);
    expect(matcher.test('node scripts/flow/reanchor.ts --to directives-4')).toBe(false);
  });

  // limite aceito: o padrão pega o descuido, não a burla (aspas que partem o literal, outro launcher)
  it.each(["node scripts/flow/reanchor.ts --ap''ply", 'bun scripts/flow/reanchor.ts --apply'])(
    'should not ask before a spelling that evades the reanchor.ts --apply pattern: %s',
    (command) => {
      const matcher = permissionMatcher('Bash(node *scripts/flow/reanchor.ts*--apply*)');

      expect(matcher.test(command)).toBe(false);
    },
  );

  it('should ask before sync-cli.ts --apply and allow no sync-cli.ts call but check', () => {
    const pattern = 'Bash(node *scripts/flow/sync-cli.ts*--apply*)';
    const matcher = permissionMatcher(pattern);

    expect(settings.permissions.ask).toContain(pattern);
    expect(settings.permissions.allow.filter((entry) => entry.includes('sync-cli.ts'))).toEqual([
      'Bash(node scripts/flow/sync-cli.ts check *)',
    ]);
    expect(matcher.test('node scripts/flow/sync-cli.ts plan --process directives-4 --apply')).toBe(
      true,
    );
    expect(
      matcher.test('node ./scripts/flow/sync-cli.ts plan --apply --process directives-4'),
    ).toBe(true);
    expect(matcher.test('node scripts/flow/sync-cli.ts plan --process directives-4')).toBe(false);
    expect(matcher.test('node scripts/flow/sync-cli.ts check --process directives-4')).toBe(false);
  });
});
