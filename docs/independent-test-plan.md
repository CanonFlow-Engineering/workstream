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
