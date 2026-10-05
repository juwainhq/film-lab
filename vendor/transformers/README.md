# @huggingface/transformers (vendored metadata only)

Film Lab's optional **Pro** mask engine loads `@huggingface/transformers`, pinned to the
exact version in `package.json` (4.3.0), as a module inside `mask-pro-worker.mjs`.

The built bundle (`dist/transformers.web.min.js`, Apache-2.0) is intentionally **not**
committed: GitHub push protection flags a 32-character hex model-id token inside the
minified library as a "Mistral AI API Key" (a false positive), which blocks pushes.

The worker therefore tries `vendor/transformers/transformers.web.min.js` first (drop the
file here to run Pro fully offline) and otherwise imports the pinned jsDelivr URL:

    https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.web.min.js

`LICENSE` (Apache-2.0) and `package.json` are kept for provenance.
