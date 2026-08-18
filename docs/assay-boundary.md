# Assay boundary

M0 and M1 pin `typescript-assay` 0.1.1 and `ste-assay` 0.2.0 in `package-lock.json`.
The lockfile records their registry integrity values. The CI workflow and Judge
receipt record the exact installed versions and artifact hashes.

The installed TypeScriptAssay package declares Node `>=20.20.2 <21`. STEAssay
0.2.0 declares Node 20.20.2 and npm 10.8.2. Workstream is a Node 24 package.
The Assay runners require Node 20.20.2 and fail before running either CLI when
that condition is not true. CI uses the same exact runner for this separate
gate.

STEAssay is Markdown only. It observes the README, agent rules, mandate
material, and M0 and M1 documentation. It cannot scan TypeScript CLI source. The CLI
reference documents that surface. The Judge separately runs installed CLI
smoke tests.
