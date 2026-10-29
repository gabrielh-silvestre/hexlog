---
name: {{project}}-hexlog
description: "Use right after {{commands}} in this repository: record the phase in hexlog, link it to the previous phase and, when the last phase ends, check that the unit is complete. Also use to continue or close a unit of work ({{unit_kind}}) that hexlog already tracks."
---

# {{project}}-hexlog

hexlog project: `{{project}}`. Gate: `{{gate}}`. Model: `hexlog-model.json`, next to this
file. Mechanics of every call (register, query, evaluate the gate) live in the
`hexlog-flow` skill; this file only carries the data of this project.

A unit of work is one {{unit_kind}} under `{{unit_location}}`.

## Phases

| Phase | Command | Record type | Target suffix | Artifact | Links |
|---|---|---|---|---|---|
| {{phase}} | {{command}} | {{type}} | {{target}} | {{artifact}} | {{links}} |

Repeat the row once per phase of the model, in order. The Links column reads `<relation name> -> <target record type>`.

## What to do

All mechanics live in `references/unit-lifecycle.md` of the `hexlog-flow` skill; open that
skill and read the file when you open a unit, register a phase or close the unit.

1. Open or continue the unit: sections "Resolver o processo da unidade" and "Sem acerto".
2. After each command in the table, register the phase: section "Registrar uma fase"
   (target `<process>.<target suffix>`, links, `key`, a phase that already has a record).
3. When the last phase is done, close the unit with the gate `{{gate}}`: section
   "Fechar a unidade". Treat `hexlog-model.json` as read-only data; change it by running
   the `hexlog-setup` skill again.

## Owner seat

Render this section only when the model has the `ownerSeat` key; otherwise leave it out. Resolve the generation placeholders from `ownerSeat.names`. The roles, the answer format and the audit are in `owner-seat/contract.md`, next to this file.

When you hit a gap you cannot close alone (a question no rule of the project answers):

1. Record the gap: type `{{type_gap}}`, target `<process>.gap.<short>`.
2. Check the seat precondition as `owner-seat/contract.md` says in "Before sitting" (the trace fields of `{{type_premise}}` in the process). A process opened before the owner seat was set up does not have them, and then nobody sits: go to step 5.
3. Run the recipe in `owner-seat/` (`recipe-claude.md` or `recipe-agy.md`, whichever exists) after filling in its variables (`GAP_ID`, `PROJECT`, `PROCESS`, `MODEL`, `CRITERIA`) in the block.
4. Read the answer back with `query` (`relatedTo` the gap id) before going on.
5. If the recipe fails, if there is no recipe or if nobody sits, ask the developer and record the answer with `answeredBy: human`, as `owner-seat/contract.md` says.

Audit report, to run when the developer asks for it (needs the `HEXLOG_CHECKOUT` variable, set once per developer to the hexlog checkout):

```text
node "$HEXLOG_CHECKOUT/scripts/seat-report.ts" {{project}} --types gap={{type_gap}},premise={{type_premise}},audit={{type_audit}}
```

Before running it, check that `$HEXLOG_CHECKOUT/scripts/seat-report.ts` and `$HEXLOG_CHECKOUT/node_modules` exist and that `node --version` is 24.18.1 or newer. If the variable is unset or a check fails, ask the developer; do not guess a path.

When you close a unit, evaluate the gate `{{gate_gaps}}` in addition to the unit gate `{{gate}}`: it fails while a gap has no answer.

## If something fails

- The process or project is missing in hexlog (the model may be out of date or applied to
  another hexlog): ask the developer to run the `hexlog-setup` skill again.
- The hexlog tools are unavailable (absent from the tool list, or the server is down):
  continue the developer's task without recording and tell the developer once; that single
  report covers every later phase.
- Change only what the developer asked for: read files only to fill the records.
