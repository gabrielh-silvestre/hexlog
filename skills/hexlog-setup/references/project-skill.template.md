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

1. Open or continue the unit: follow `references/unit-lifecycle.md` in the
   `hexlog-flow` skill (find the process by the unit path, or create it).
2. After each command in the table, register one record of the phase type with the
   target `<process>.<suffix>`, the unit path in `unit` and the other fields that the
   phase type declares in `hexlog-model.json` (for example a short `summary`, and the
   attachment hash in the attachment field when the artifact is long). For each link in
   the table, query the process for the current record of the target type and add the
   named relation pointing to that record id.
3. When the last phase is done, close the unit: evaluate the gate `{{gate}}`, then query
   one record per phase. If a phase has no record, tell the developer, list the missing
   phases and offer a retroactive record built from the phase artifact. Never edit
   `hexlog-model.json` while using the unit.

## If something fails

- The process or project is not found: the model may be out of date or never applied to
  this hexlog. Ask the developer to run the `hexlog-setup` skill again.
- Anything the developer did not ask for stays unchanged: read files only to fill the
  records.
