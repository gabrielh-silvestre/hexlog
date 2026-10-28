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

## If something fails

- The process or project is missing in hexlog (the model may be out of date or applied to
  another hexlog): ask the developer to run the `hexlog-setup` skill again.
- The hexlog tools are unavailable (absent from the tool list, or the server is down):
  continue the developer's task without recording and tell the developer once; that single
  report covers every later phase.
- Change only what the developer asked for: read files only to fill the records.
