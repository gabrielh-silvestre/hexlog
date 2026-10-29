# Owner seat recipe: Claude Code

Status: proven

Runs the occupant of the owner seat with `claude -p`, one turn per gap. The status line
above says whether this recipe was run end to end: `proven` only for the environment where
it was run, `unproven` otherwise. This text is generated from a template, so the line shows
the state of the template, not of your machine, until someone runs the recipe here. Run it from the repository root, so the hexlog server
resolves the criteria path as the contract expects.

The contract is `contract.md`, in the same folder as the criteria file. The occupant gets it
as system prompt, and the prompt carries only the task.

## Before running

- `claude` is installed and logged in, and `node` is available (hexlog requires it).
- hexlog is registered in Claude Code: `~/.claude.json` has a `hexlog` entry under
  `mcpServers`.
- The process of the gap has the trace fields of the owner seat (see "Before sitting" in
  the contract). If not, do not run this recipe: ask the human.
- Pick the model id (`MODEL` below). The same id goes to the occupant, which records it as
  the `model` of its answer.

## Run

Fill the values in the first lines. The block copies only the `hexlog` entry of
`~/.claude.json` into a temporary file readable by you alone, and removes it at the end. It
never prints that file, because `~/.claude.json` can hold secrets of other servers.

```bash
set -eu
GAP_ID='{{gap_id}}'
PROJECT='{{project}}'
PROCESS='{{process}}'
MODEL='{{model}}'
CRITERIA='{{criteria_path}}'
SEAT_DIR="$(dirname "$CRITERIA")"

MCP_CONFIG="$(mktemp)"
trap 'rm -f "$MCP_CONFIG"' EXIT
chmod 600 "$MCP_CONFIG"
node -e '
const fs = require("node:fs");
const os = require("node:os");
const all = JSON.parse(fs.readFileSync(os.homedir() + "/.claude.json", "utf8"));
const entry = all.mcpServers?.hexlog;
if (entry === undefined) {
  console.error("hexlog is not registered in Claude Code");
  process.exit(1);
}
const { type, command, args, env } = entry;
process.stdout.write(JSON.stringify({ mcpServers: { hexlog: { type, command, args, env } } }));
' > "$MCP_CONFIG"

TASK="Close gap $GAP_ID of project $PROJECT, process $PROCESS. Model id: $MODEL. Criteria file: $CRITERIA. Follow the contract."

claude -p \
  --model="$MODEL" \
  --restricted \
  --permission-mode=dontAsk \
  --strict-mcp-config \
  --mcp-config="$MCP_CONFIG" \
  --allowedTools=mcp__hexlog__register,mcp__hexlog__attach,mcp__hexlog__query,mcp__hexlog__read_attachment,mcp__hexlog__describe_type,mcp__hexlog__list \
  --disable-slash-commands \
  --append-system-prompt-file="$SEAT_DIR/contract.md" \
  -- "$TASK"
```

`--allowedTools` and `--mcp-config` accept several values and would swallow the prompt: keep
the `=` form and the `--` before the prompt.

Afterwards, read the answer back with `query` (`relatedTo` the gap id) before going on. To
inspect a run, add `--output-format=stream-json --verbose`.

## Why these flags

- `--restricted` removes `Bash` and the other tools that run code, ignores the user, project
  and local settings (and so their hooks and global instructions), and confines the file
  tools to the working directory. That is what keeps `Read`, `Grep` and `Glob` away from the
  hexlog data directory once the user deny rules are out of play.
- `--strict-mcp-config` with `--mcp-config` loads only the `hexlog` server.
- `--permission-mode=dontAsk` denies whatever is not allowed instead of prompting, and
  `bypassPermissions` is never used.
- The allowlist names the six hexlog tools the contract needs. It has no unscoped `Read`,
  `Grep` or `Glob`.

## Turning on `web`

Only when the developer wants the occupant to search external sources. `--restricted` removes
`WebFetch`, and `--tools` brings it back. Keep `--restricted` and add both flags:

```text
--tools=Read,Grep,Glob,WebFetch,WebSearch
--allowedTools=...,WebFetch,WebSearch    (the six tools above plus these two)
```

## Fallback if `--restricted` blocks the hexlog server

Replace `--restricted` with the lines below, and keep every other flag. `--tools=Read` leaves
only file reading among the built-in tools, with no `Grep` or `Glob`, which would not be
confined. Add `Read(./**)` to `--allowedTools`.

```text
--tools=Read
--setting-sources project,local
```

With this fallback `web` is not available.

## What the first run settled

Run end to end on one machine, with the flags above and no fallback:

- The hexlog server keeps working under `--restricted` with `--strict-mcp-config`.
- Under `dontAsk`, reading files inside the repository needs no entry in `--allowedTools`.
  Reading outside it is refused with "outside the working directory".
- The final `result` event of `stream-json` carries `permission_denials`; it was empty in
  every normal run.
- The server started by Claude Code inherits `XDG_DATA_HOME` from the environment of the
  command.
- `--append-system-prompt-file` is accepted as written, and the occupant follows the
  contract.
