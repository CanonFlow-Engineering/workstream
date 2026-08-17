# M0 architecture

Workstream has one local storage boundary. `.workstream/workstream.db` is a
SQLite database with an append-only event ledger and read projections. The
database uses Node.js 24 `node:sqlite`; no service process is required.

Each event records a sequence, actor, timestamp, type, canonical JSON payload,
previous SHA-256 hash, and SHA-256 hash. The hash covers all preceding event
fields except the hash itself. `verify` walks that chain in sequence order.

Evidence is written once below `.workstream/evidence/sha256/`. Its filename is
the SHA-256 of its bytes. The database references the address and byte length.
Verification checks both values again.

SQLite projections make queue and work views efficient. The event ledger and
evidence remain the portable record. `export` writes a bundle with canonical
events and evidence. `import` accepts only an empty local store after it checks
the manifest, file layout, event chain, and every artifact.

The GitHub integration seam is a dry-run interface. It has no token input,
network client, synchronization, or external write in M0.
