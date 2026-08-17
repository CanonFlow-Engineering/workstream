# Independent test plan

The Independent Tester works from the packed npm artifact in a new temporary
consumer directory. It must not import `src/`, private helpers, Architect test
utilities, or candidate hash functions.

The tester checks SQLite persistence after restart, transaction rollback,
denied-command non-mutation, event ordering, event-chain verification, actor
permissions, evidence mutation detection, and export/import equivalence.

The tester also changes event bytes, manifest bytes, artifact bytes, schema
values, and archive paths. Each changed bundle must be rejected. It runs the
installed CLI offline and records the command, expected result, actual result,
evidence path, and SHA-256 digest.

For M1, the tester starts the installed local server on `127.0.0.1` and checks
the health response and bundled browser assets. It must confirm that the
response declares local-only, dry-run GitHub integration. It must not make a
remote network request or use credentials.

For M2A, the tester creates evidence-linked Compass drafts, checks named-owner
approval and supersession, and verifies that a generated `VISION.md` imports as
a new source-evidenced draft. It also tests idea expiry, assumption results,
immutable decision supersession, milestone validation, and Skeptic denials for
work claim, work evidence, test, Judge, and gate actions. Export/import must
replay every Compass projection and reject any altered Compass evidence.
