// Hook do fluxo autônomo guiado por diretrizes (modos `pre-pr` e `subagent-start`). O hook só
// importa builtins, `scripts/flow/marker.ts` e `./flow-command.ts`, para rodar em worktree sem `node_modules`. Não lê o
// log do hexlog: a decisão de PR olha só o git e o marcador.
import * as fs from 'node:fs';
import { currentBranch, git, markerPath, slugOf, tryGit } from '../../scripts/flow/marker.ts';
import { findPrCommands, type PrCommand } from './flow-command.ts';

const PR_TOOLS = {
  create: 'mcp__github-official__create_pull_request',
  update: 'mcp__github-official__update_pull_request',
};

const MARKER_HINT =
  'run the pre-PR step of flow-run, or open the PR as a draft when a gap is open; to take a draft ' +
  'out of draft, close the gaps with flow-gaps and run gh pr ready';

type HookInput = { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function readInput(): HookInput {
  const input: unknown = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!isRecord(input)) throw new Error('hook input is not a JSON object');
  return input;
}

/** `owner/repo` em minúsculas de uma URL de remoto (ssh, https, com ou sem `.git`). */
function ownerRepoOf(url: string): string {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`cannot read owner/repo from origin url "${url}"`);
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function assertSameRepository(cwd: string, owner: string, repo: string): void {
  const origin = ownerRepoOf(git(cwd, ['remote', 'get-url', 'origin']));
  if (origin !== `${owner}/${repo}`.toLowerCase()) {
    throw new Error(`PR targets ${owner}/${repo}, but origin is ${origin}`);
  }
}

/** Passa só com o marcador de `head` gravado pelo `mark`: branch e sha batem com as refs atuais. */
function assertMarker(cwd: string, head: string): void {
  if (head.includes(':')) throw new Error(`cross-repo PRs unsupported (head "${head}")`);
  const file = markerPath(cwd, slugOf(head));
  const marker = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : undefined;
  const sha = git(cwd, ['rev-parse', '--verify', `refs/heads/${head}`]);
  const remoteSha = tryGit(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${head}`,
  ]);
  const stale = marker?.[0] !== head || marker[1] !== sha || (remoteSha ?? sha) !== sha;
  if (stale) throw new Error(`no valid pre-PR marker for branch "${head}": ${MARKER_HINT}`);
}

function assertMcpPrAllowed(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): void {
  if (toolName === PR_TOOLS.update) {
    if (toolInput.draft === false) {
      throw new Error('taking a PR out of draft through the MCP is denied: use gh pr ready');
    }
    return;
  }
  if (toolInput.draft === true) return;
  const head = asString(toolInput.head) ?? '';
  const owner = asString(toolInput.owner) ?? '';
  const repo = asString(toolInput.repo) ?? '';
  if (head.includes(':')) throw new Error(`cross-repo PRs unsupported (head "${head}")`);
  assertSameRepository(cwd, owner, repo);
  assertMarker(cwd, head);
}

/** Valor da opção `--name V`, `--name=V` ou `-N V` em `args`. */
function optionValue(args: string[], names: string[]): string | undefined {
  for (const [i, arg] of args.entries()) {
    if (names.includes(arg)) return args[i + 1];
    const inline = names.find((name) => name.startsWith('--') && arg.startsWith(`${name}=`));
    if (inline) return arg.slice(inline.length + 1);
  }
  return undefined;
}

const hasRepoOption = (args: string[]): boolean =>
  args.some((arg) => arg === '-R' || arg === '--repo' || arg.startsWith('--repo='));

const looksLikePrReference = (arg: string): boolean =>
  /^#?\d+$/.test(arg) || /^https?:\/\//.test(arg);

function assertGhPrAllowed({ kind, args }: PrCommand, cwd: string): void {
  if (hasRepoOption(args)) throw new Error('gh -R/--repo is denied: the PR branch is unknown');
  if (kind === 'create') {
    if (args.includes('--draft') || args.includes('-d')) return;
    assertMarker(cwd, optionValue(args, ['--head', '-H']) ?? currentBranch(cwd));
    return;
  }
  if (args.includes('--undo')) return;
  const [target, ...extra] = args.filter((arg) => !arg.startsWith('-'));
  if (target !== undefined && (extra.length > 0 || looksLikePrReference(target))) {
    throw new Error(
      'gh pr ready by number or URL is denied (the branch is unknown): run it without arguments ' +
        'in the checkout of the PR branch, or pass the branch name',
    );
  }
  assertMarker(cwd, target ?? currentBranch(cwd));
}

/** Lança, com o motivo, se a chamada de ferramenta abre ou tira de rascunho um PR sem marcador. */
function assertPrAllowed(input: HookInput): void {
  const toolName = asString(input.tool_name);
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  const cwd = asString(input.cwd) ?? process.cwd();
  if (toolName === PR_TOOLS.create || toolName === PR_TOOLS.update) {
    assertMcpPrAllowed(toolName, toolInput, cwd);
    return;
  }
  const command = toolName === 'Bash' ? asString(toolInput.command) : undefined;
  if (command === undefined) return;
  const { commands, unclosedMatch } = findPrCommands(command);
  if (unclosedMatch) throw new Error('unparsable shell command mentions gh pr create/ready');
  for (const prCommand of commands) assertGhPrAllowed(prCommand, cwd);
}

function subagentStart(): void {
  let cwd = process.cwd();
  try {
    cwd = asString(readInput().cwd) ?? cwd;
  } catch {
    // sem entrada legível o contexto sai igual, só que no cwd do processo
  }
  let slug = '<unavailable: not on a branch>';
  try {
    slug = slugOf(currentBranch(cwd));
  } catch {
    // detached HEAD, branch reservada ou fora de repositório: o subagente fica sem o slug
  }
  const additionalContext = [
    'Record choices between viable alternatives in hexlog as decision records, following ' +
      'docs/directives/fluxo-hexlog.md; subagents decide and register too. ' +
      'Found a NEW gap or critical point nobody handed you? Stop and hand it back to whoever ' +
      'launched you (docs/directives/cadeira-do-dono.md); the owner-seat critic and its context ' +
      'actions answer instead of handing back.',
    `Hexlog project: hexlog; work process: ${slug} (slug of the current branch); ` +
      'if that process does not exist yet, tell whoever launched you instead of registering.',
    'Open a PR only through the pre-PR step of flow-run.',
  ].join('\n');
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext } }),
  );
}

function run(mode: string | undefined): void {
  if (mode === 'pre-pr') return assertPrAllowed(readInput());
  if (mode === 'subagent-start') return subagentStart();
  throw new Error(`unknown mode "${mode ?? ''}"`);
}

/** Bloqueia com exit 2 e o motivo no stderr. */
function main(): void {
  try {
    run(process.argv[2]);
  } catch (error) {
    process.stderr.write(
      `hexlog flow: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

main();
