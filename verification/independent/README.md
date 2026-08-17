# Independent installed-package verification

This suite deliberately imports no candidate source, private module, test
helper, or candidate hash function. It packs the candidate, installs that
tarball into a new temporary consumer directory while npm is offline, and
exercises only the installed public package and CLI.

Run it after `npm pack` with the package's pinned Node 24 binary:

```text
WORKSTREAM_TARBALL="$PWD/canonflow-workstream-0.0.0.tgz" \\
WORKSTREAM_NODE="$PWD/node_modules/node/bin/node" \\
"$PWD/node_modules/node/bin/node" --test verification/independent/installed-package.test.mjs
```

It is not included in the package and does not alter the candidate runtime.
