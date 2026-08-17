# Evidence contract

Evidence is immutable byte content addressed by SHA-256. A reference contains
the digest, byte length, and a fixed relative path. It does not contain an
untrusted filesystem path.

An event hash is the SHA-256 of canonical JSON with these exported fields:
sequence, actor, timestamp, type, payload, and previous SHA-256. `actor` is
the exported object with `kind` and `id` fields. The first event uses 64 zero
characters as its previous hash.

An export bundle contains:

- `manifest.json` with schema, event digest, and sorted evidence references.
- `events.ndjson` with canonical one-event-per-line records. `eventsSha256`
  is the SHA-256 of its exact UTF-8 file bytes, including its final newline.
- `evidence/sha256/<digest>` files for every manifest reference.

Import rejects an unsupported schema, a changed event digest, a changed event
hash, a missing file, an unexpected evidence path, a symlink, duplicate
addresses, or bytes that do not match their digest. These checks establish
integrity of observed local data. They do not establish authorship or truth.
