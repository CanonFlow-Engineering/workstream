# Compass local-first direction

Compass is Workstream's M2A direction record. It turns a possible product
direction into local, reviewable ledger events before a build milestone begins.
It does not make a decision for a human and does not create an external effect.

## Source of truth

The append-only SQLite ledger is the source of truth. Compass tables are local
read projections rebuilt during verified import. Every principle and non-goal
references content-addressed evidence already linked to its project.

An approved Compass is projected into a human-readable `VISION.md`. The
projection contains a stable marker and evidence addresses. It can be imported,
but import always creates a new draft and stores the entire imported file as
source evidence. Editing an exported file does not change the approved Compass.

## Records

- A Compass draft has an identifier, project, named human owner, version,
  evidence-linked principles, and evidence-linked non-goals.
- The named owner alone can approve a draft. To change an approved direction,
  that owner creates a replacement draft and supersedes the prior version.
- An idea records its problem, affected user, expected result, evidence,
  assumption, risk, cost estimate, rejection reason, and expiry.
- An assumption records an owner, confidence, test method, expiry, and one
  immutable result. Expiry is reported from the observed local clock.
- A trade-off card records its question, yes case, no case, evidence, and one
  human accept, reject, or defer decision.
- A decision is immutable. A later decision may name one prior decision it
  supersedes and must state why.
- A milestone contract records a user problem, smallest useful result,
  non-goals, acceptance tests, required evidence, risks, rollback condition,
  and human gate.

## Roles and limits

Actor labels remain trusted-local workflow labels, not identity authentication.
The `skeptic-agent` role can create local direction records such as ideas and
trade-offs, but cannot claim work, record tests, record a Judge result, or make
a gate decision. It is not a builder, tester, Judge, or approver.

Compass is deliberately local-only. It has no GitHub read or write path, remote
synchronization, credential input, command execution, account system,
publication, release, deployment, or hosted service. A human gate event is a
local workflow record only; it does not authorize a merge, publication, release,
deployment, GitHub write, or any other external action.
