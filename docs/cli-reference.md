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
