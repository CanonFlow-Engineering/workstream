# Agent operating rules

This repository records controlled work. Agents work only within a human
mandate and an assigned work item.

## Required sequence

1. A human creates the project, work item, and mandate.
2. An Architect agent claims ready work and attaches implementation evidence.
3. An Independent Tester records package-level test evidence.
4. An LLM Judge records one evidence-based verdict.
5. A human accepts, rejects, or stops the work.

## Prohibited agent actions

An agent must not self-approve work. An agent must not claim blocked work.
M0 has no agent path for merge, tag, publication, release, deployment, user
invitation, credential change, or permission change.

Do not treat a ledger event as proof beyond its attached evidence. Preserve
the local evidence bytes and use `workstream verify` before handoff.

## Policy and workflow changes

Review changes to `.workstream` policy and automation with the same care as a
continuous-integration workflow. Do not execute unreviewed commands or accept
evidence from an untrusted source.
