# Kept

**Know what you owe. See what changed.**

A private commitment memory: it turns passages from messages and meeting notes into an evidence-backed view of who owes what, what changed, and what is blocked. The graph lives in the browser in [Relate](https://relatedb.ai), and extraction runs through [Firebase AI Logic](https://firebase.google.com/docs/ai-logic) on the device model built into Chrome, with the cloud as a fallback where that is allowed.

## Status

As of 2026-11-15 this repository holds the groundwork, not the finished app.

| Part | State |
|---|---|
| Feasibility slice (`index.html`) | Works: Relate in a worker with a persistent store, hybrid extraction on device and in the cloud, App Check, a hosted build |
| Commitment model (`src/model.js`) | Rules written and tested on Relate's Node binding. Not run in the browser build, not used by the page yet |
| Answer validation (`src/reading.js`) | Written and tested. Not used by the page yet |
| Linking experiment (`linking.html`) | A development tool. Results in `docs/linking-experiment.md` |
| Review screen (`review.html`) | First increment, **not yet opened in a browser**: the demo scenario loaded through the model's rules, the review queue with accept, reject and "it is about another commitment", and the four core questions. No model runs on this page yet |
| Capture, and the model's answers feeding the review screen | Not built |
| Store file in the repository (`store/kept.rl`) | **Out of date:** still the slice's first seed model. See "The graph" |

## Run it

Needs Node.js and desktop Chrome. The tests were run with Node.js 24.

```
npm install
npm run dev
```

Then open http://localhost:5173/ for the feasibility slice, http://localhost:5173/review.html for the review screen, and http://localhost:5173/linking.html for the linking experiment. The review screen uses its own store (`opfs://kept-demo`), so it can be open beside the slice.

- `npm install` copies Relate's browser files into `public/relate/` with `mkdir -p` and `cp`. On Windows, run `npm ci --ignore-scripts` and then the `copy-relate` command from `package.json` in Git Bash.
- **The device model.** Chrome serves Gemini Nano 3 by default. For Gemma 4, set `chrome://flags/#gemma4-for-built-in-ai` to Enabled and relaunch. The linking page shows which model answers.
- **The cloud model on localhost** needs this browser's App Check debug token registered in the Firebase console (App Check > Apps > Manage debug tokens). Both pages print the token. The hosted build uses reCAPTCHA Enterprise and needs no setup.

A hosted build of the slice is at https://relate-hybrid.web.app.

## Tests

```
npm test
```

105 tests: the commitment rules and the review screen's data against a real Relate store through the Node binding, the validation of model answers, and the scoring of the linking experiment. No model and no browser are involved.

## The graph

> **The store file is out of date.** `store/kept.rl` still holds the first seed model of the feasibility slice (`Evidence` and `Deadline` nodes), not the model described in `docs/data-model.md` and implemented in `src/model.js`. It has to be regenerated from the accepted model before submission.

- **In the browser:** a Relate store in OPFS, opened from a dedicated worker (`src/db.worker.js`).
- **In the repository:** `store/kept.rl`, a single-file Relate store built from the same seed data as the browser's demo (`npm run seed-store`). Inspect it with the Relate CLI:

  ```
  relate -d store/kept.rl "MATCH (n) RETURN labels(n)[0] AS label, count(*) AS nodes"
  ```

Relate features in use: the WebAssembly build with OPFS persistence, the Node binding (tests and the store file), Cypher with quantified path patterns and `EXISTS` subqueries, and a full-text index.

## Documentation

| File | What it holds |
|---|---|
| `docs/decisions.md` | Product definition, platform, privacy and inference policy, and the decisions the other documents refer to |
| `docs/data-model.md` | The commitment model, its write rules, the core questions as queries, and what the tests establish |
| `docs/linking-experiment.md` | Whether a model attaches a note to the right existing commitment: runs on device and in the cloud, and the routing decided from them |
| `docs/slice-results.md` | What the feasibility slice tested, on which machines, and what it found |

## How this was built

- **Start.** The first commit is dated 2026-11-14. The research behind it began the same day.
- **Reused code.** Not yet declared. Whether any code here comes from an earlier project is for the author to state before submission. It has not been verified by the AI tools or reviews named below, and a first commit date does not establish it.
- **Third-party.** Relate (`@relate/relate-wasm`, `@relate/relate`), the Firebase JS SDK (AI Logic, App Check, Hosting), Vite.
- **AI assistance.** Substantial. The research notes, the documents in `docs/`, and most of the code and tests were written with Claude Code (Anthropic) under the author's direction. Implementation and tests were iteratively reviewed with OpenAI Codex, whose findings were reproduced and fixed with tests. The author ran every browser and device experiment, supplied the results, and made the product decisions.
