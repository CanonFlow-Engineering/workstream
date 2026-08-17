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

## Local browser command

Use `serve [path] [--port 3210]` to start the M1 browser interface. It binds
only to `127.0.0.1` and serves bundled local assets. Its API applies the same
actor and state permission checks as the CLI. It has no remote GitHub client,
credential input, command execution route, or two-way synchronization.
