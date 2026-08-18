# CLI reference

`src/cli-help.md` is the canonical Markdown help source. The CLI reads that
file at runtime. The build copies it into the packed `dist/` directory. The
help-drift regression test requires `workstream --help` to match it exactly.

## State commands

Use `init`, `project create`, `work create`, `mandate issue`, and `work claim`
to establish a mandated work item. The actor flag is required for state changes.

## Evidence commands

Use `evidence attach`, `handoff create`, `test record`, `judge record`, and
`gate decide` to record the controlled loop. Test and Judge commands require
the SHA-256 from an attached evidence object.

## Inspection commands

Use `verify`, `work show`, `work queue`, `work blocked`, and `activity` to
inspect local state. Use `export` and `import` to move a verified bundle.

## Compass commands

Use `compass evidence` to attach a human-provided local source to a project
before creating a Compass draft. `compass create`, `compass approve`, and
`compass supersede` manage human-owned Compass versions. Use `vision export`
only after approval; `vision import` creates a new draft and attaches the
imported projection as local source evidence.

The `idea`, `assumption`, `tradeoff`, `decision`, and `milestone` commands use
explicit JSON records for bounded structured direction data. They do not call a
remote service or execute a command. `skeptic-agent:<id>` is accepted as a
local actor label but is denied work claims, test recording, Judge recording,
and gate decisions.

## Shape, readiness, and outcome commands

Use `shape create` with an explicit JSON record after a human has marked its
selected idea `shaped`. Only the Shape brief's named human owner can use
`shape approve`. The record must include its evidence links, stated
assumptions, scope controls, and measurable success criteria.

Use `launch create` to prepare a local readiness record for an approved Shape
brief. `launch authorize` records the named human owner's local workflow
authorization. It does not execute a launch, run a command, write to GitHub,
or create a remote effect.

Use `outcome create` to copy a Shape brief's success criteria into an immutable
expected measure. A human uses `outcome record` to record an observed result,
changed assumption, and `keep`, `change`, or `stop` decision.

## Local browser command

Use `serve [path] [--port 3210]` to start the M1 browser interface. It binds
only to `127.0.0.1` and serves bundled local assets. Its API applies the same
actor and state permission checks as the CLI. It has no remote GitHub client,
credential input, command execution route, or two-way synchronization.

Actor IDs supplied to the local API are ledger role labels, not authentication.
The browser gate is a trusted-local workflow control only. It does not
authorize a merge, publication, release, deployment, GitHub write, or another
external action.
