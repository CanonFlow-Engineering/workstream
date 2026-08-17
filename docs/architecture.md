# M0 and M1 architecture

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
network client, synchronization, or external write in M0 or M1.

## M1 local browser boundary

`workstream serve` starts a Node.js HTTP server on `127.0.0.1`. It serves
bundled static HTML, CSS, and JavaScript and exposes a small same-origin local
JSON API. The API opens the same SQLite store for each request and applies the
existing domain permission checks before every mutation. Actor IDs identify
ledger roles. They are not authentication, authorization, or a security
boundary for a browser client. The local server is for a trusted local machine.

The interface has four views: projects, a work board, work evidence and
handoffs, and the human approval queue. It can attach local text evidence and
record the already-admitted Tester or Judge results. It cannot run commands,
receive credentials, or make a GitHub request. The server exposes only fixed
static assets and fixed API routes; it does not map browser paths to arbitrary
filesystem paths.

The browser does not make verification authoritative by itself. It is a local
projection and entry surface for the same ledger. The human gate remains a
permission-checked ledger event. It is a trusted-local workflow control. It
does not authorize a merge, publication, release, deployment, GitHub write, or
another external action.
