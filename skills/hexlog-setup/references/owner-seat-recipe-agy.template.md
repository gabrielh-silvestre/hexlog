# Owner seat recipe: agy

Runs the occupant of the owner seat with `agy -p`, one turn per gap. Run it from the
repository root.

`agy` has no flag for a system prompt, so the prompt is the text of `contract.md` (in the same
folder as the criteria file) followed by the task, in a single argument of `-p`.

## Risk to accept

`agy` has no allowlist of tools and none of the deny rules of the hexlog installer, and this
recipe runs it with `--dangerously-skip-permissions`. The occupant can therefore run shell
commands, write or delete files and use the network with your environment and credentials,
and read any file you can, including the hexlog data directory. It also reads the
`AGENTS.md` of the repository. The contract tells it to stay in scope and to treat what it
reads as data (the gap, the criteria and the repository files); that is an instruction, not
a barrier, and text it reads can still steer it. The developer owns this risk. Do not use
this recipe on a machine or a repository where that is not acceptable.

## Before running

- `agy` is installed and logged in: `agy models` exits 0 and lists the model ids.
- hexlog is registered in `agy`. The hexlog installer registers it only in Claude Code, so
  register it once by hand. Take the command and the arguments from the `hexlog` entry of
  `~/.claude.json` (flags go before the name):

  ```bash
  agy mcp add hexlog node /absolute/path/to/server.mjs
  ```

- The server registered in `agy` is the same file as the one in `~/.claude.json`. The
  installer keeps several versions side by side, and `agy` stays on the old one without a
  warning. The block below checks it and stops if they differ.
- The process of the gap has the trace fields of the owner seat (see "Before sitting" in
  the contract). If not, do not run this recipe: ask the human.
- Pick the model id (`MODEL` below) from `agy models`. The same id goes to the occupant,
  which records it as the `model` of its answer.

## Run

```bash
set -eu
GAP_ID='{{gap_id}}'
PROJECT='{{project}}'
PROCESS='{{process}}'
MODEL='{{model}}'
CRITERIA='{{criteria_path}}'
SEAT_DIR="$(dirname "$CRITERIA")"

SERVER="$(node -e '
const fs = require("node:fs");
const os = require("node:os");
const all = JSON.parse(fs.readFileSync(os.homedir() + "/.claude.json", "utf8"));
const entry = all.mcpServers?.hexlog;
if (entry === undefined) {
  console.error("hexlog is not registered in Claude Code");
  process.exit(1);
}
process.stdout.write(String(entry.args?.[0] ?? ""));
')"
agy mcp list | grep -F -- "$SERVER" > /dev/null || {
  echo "agy points to another hexlog server than Claude Code ($SERVER): re-register it first" >&2
  exit 1
}

TASK="Close gap $GAP_ID of project $PROJECT, process $PROCESS. Model id: $MODEL. Criteria file: $CRITERIA. Follow the contract above."

agy -p "$(cat "$SEAT_DIR/contract.md"; printf '\n\n%s\n' "$TASK")" \
  --model "$MODEL" \
  --dangerously-skip-permissions \
  --disable-slash-commands
```

The block reads only the `hexlog` entry of `~/.claude.json` and never prints that file, which
can hold secrets of other servers.

Afterwards, read the answer back with `query` (`relatedTo` the gap id) before going on. To
inspect a run, add `--output-format stream-json`.

## Differences from the Claude Code recipe

- There is no `jury` and no subagent: the occupant researches with its own tools. The
  `local` and `web` actions are whatever `agy` provides natively.
- There is no tool allowlist. In print mode the `mcp` permission is denied without a prompt
  ("a tool required the mcp permission that headless mode cannot prompt for"), so the recipe
  needs `--dangerously-skip-permissions`. `--mode auto` is refused on some accounts ("not
  available for this account") and then leaves that denial in place. The risk above is the
  price of this flag.

## What the first run settled

Run end to end on one machine, with two gaps (one answered by a rule, one by judgment):

- `agy mcp list` shows the server arguments, so the version check above works.
- The server started by `agy` runs in the repository root, so `attach` by `path` resolves
  relative to it, as the criteria path expects.
- `--model` accepts the id as `agy models` lists it.

## Still unverified

- Whether the hexlog server started by `agy` inherits `XDG_DATA_HOME` from the environment
  of the command. The run registered the server with `agy mcp add --env XDG_DATA_HOME=...`
  and did not test the inheritance. Register it that way if you use a data directory other
  than the default.
