# Kept

**Know what you owe. See what changed.**

A private commitment memory. Paste a passage from a message or meeting notes, and Kept turns it into an evidence-backed view of who owes what, what changed and what is blocked. Nothing a model reads changes a commitment until you confirm it.

- **Hybrid inference.** Notes are read through [Firebase AI Logic](https://firebase.google.com/docs/ai-logic): by the model built into Chrome (Gemini Nano) on the device, or by Gemini in the cloud. The workspace decides which, not the model.
- **A graph that does the reasoning.** Commitments, people, notes and every proposed change live in [Relate](https://relatedb.ai), in the browser. "What do I owe before Friday?" and "what is waiting on someone else?" are graph queries over accepted state, each answer linked to the words it came from.

Hosted: https://relate-hybrid.web.app

## The use case

Commitments get lost in the middle of conversations: "I'll send Dana the proposal Friday, once Lee confirms pricing." Two days later Lee's pricing slips; the next day Dana moves the date. Kept keeps:

- the **commitment** (owner, recipient, deadline, status), holding only what you accepted;
- every **change** as its own record, with the quote and the note it came from, waiting for review;
- **dependencies** between commitments ("once Lee confirms pricing"), so blockers come from traversal, not from a model;
- the **notes** themselves, so "why does the app think this is mine?" is answered with the original sentence.

It answers four questions: what do I owe before a date, which commitments are waiting on someone else, what changed since the last meeting with someone, and why the app thinks a commitment is yours.

## How it uses Firebase AI Logic

`src/ai.js` creates the models with `getGenerativeModel` and an `InferenceMode`, behind App Check (reCAPTCHA Enterprise on the hosted site, a debug token on localhost). The output is JSON constrained by a schema.

| Workspace | Mode | Where the note goes |
|---|---|---|
| Demo (`/`) | Cloud (`gemini-3.5-flash-lite`) | The note and your open commitments go to the cloud model; demo data only |
| Demo, "read on this device when its model is ready" ticked | `PREFER_ON_DEVICE` | Gemini Nano in Chrome when its model is ready; the cloud when it is not, or when the device call fails or takes over 45 s. The status line says which model answered and, if the cloud stood in, why |
| Private (`/?workspace=private`) | `ONLY_ON_DEVICE` | Read by Gemini Nano in Chrome, never leaves the device. Proposals are marked provisional |
| Private, cloud opt-in | Cloud, for one note | Only after ticking a box and seeing a preview of exactly what will be sent. The box unticks itself after that note |

The private workspace never uses `PREFER_ON_DEVICE`: when the model is missing, that mode sends the note to the cloud with nothing but the reported source to show it. The fallback is offered only where the data is demo data, and the prefer-on-device decision is in `src/hybrid.js`, tested on its own.

Before an on-device call the app checks itself that the model is available and answering, because the SDK alone would start a multi-gigabyte download instead of failing. A device call that takes over 45 s is stopped.

Every answer, from either model, passes through validation (`src/reading.js`) and the app rules (`src/model.js`). It becomes proposals, questions or refused entries, and only a confirmation changes a commitment. The routing comes from measurement: on the same notes the cloud model was right or asked, and the device model sometimes proposed something wrong without saying it was unsure (`docs/linking-experiment.md`, `docs/evaluation.md`). So on the device every link is provisional and review is mandatory.

## How it uses Relate

**Mode: single file** in the repository, and a persistent OPFS store in the browser.

- **In the browser:** Relate's WebAssembly build, opened from a dedicated worker (`src/db.worker.js`) and persisted to OPFS. The demo and the private workspace are separate stores (`opfs://kept-demo`, `opfs://kept-private`), so private notes never share a store with demo data.
- **In the repository:** `store/kept.rl`, a single-file store built with the Node binding from the demo scenario, through the same rules the app uses (`npm run seed-store`). It is there so you can inspect the graph without a browser.

Graph: `Person`, `Commitment`, `Note` and `Change` nodes; `OWES`, `TO`, `BLOCKED_BY`, `ON`, `FROM`, `NAMES`, `INVOLVES` and `ESTABLISHED_BY` relationships (each current value points at the change that set it). Queries use quantified path patterns, `EXISTS` subqueries and a full-text index. The model and its queries are in `docs/data-model.md`.

## Run it

Needs Node.js (tested with 24) and desktop Chrome.

```
npm install
npm run dev
```

Open http://localhost:5173/ and press **Load the demo scenario**.

- On Windows, `npm install`'s copy step uses `mkdir -p` and `cp`: run `npm ci --ignore-scripts`, then `npm run copy-relate` in Git Bash.
- **The cloud model on localhost** needs this browser's App Check debug token registered in the Firebase console (App Check > Apps > Manage debug tokens); the page prints it. Or use the hosted site, which needs no setup.
- **The device model.** Chrome serves Gemini Nano 3 by default. For Gemma 4, set `chrome://flags/#gemma4-for-built-in-ai` to Enabled and relaunch. The private workspace says whether the model is ready and answering.

Other pages, for development: `/slice.html` (the feasibility slice), `/linking.html` (the linking experiment), `/eval.html` (the capture evaluation, `npm run eval`).

## Where the data lives

- `store/kept.rl`: the inspectable store. Regenerate it with `npm run seed-store`, which also prints the node and relationship counts and the answers to the core questions. With the Relate CLI:

  ```
  relate -d store/kept.rl "MATCH (n) RETURN labels(n)[0] AS label, count(*) AS nodes"
  relate -d store/kept.rl "MATCH (c:Commitment)-[:BLOCKED_BY]->(b:Commitment)<-[:OWES]-(p:Person) RETURN c.what, b.what, p.name"
  ```

- In the browser: OPFS, per workspace, on your machine only.
- Nothing in the repository is real personal data. The demo scenario is invented.

## Tests

```
npm test            # on Relate's Node binding, about 2 s
npm run test:wasm   # on Relate's browser build, in headless Chromium, about 15 s
```

200 tests against a real Relate store: the commitment rules, the review screen's data and capture, validation of model answers, dependencies, the device guard and the evaluation scoring. `test:wasm` runs the same tests on the WebAssembly build the app uses, in a dedicated worker on an OPFS store (`test/store.mjs`); it needs Playwright's Chromium (`npx playwright install chromium`). No model is involved. The model itself is measured separately, in `docs/evaluation.md` (21 rounds on the device, written before any model saw them).

## Status

| Part | State |
|---|---|
| Review screen (`/`) | Demo scenario, capture, review queue with accept, reject and "it is about another commitment", the four core questions. Checked by hand in Chrome 157 on Windows |
| Capture, cloud | Deadline changes, new commitments, done and cancelled, dependencies, questions for ambiguous notes. Run end to end in Chromium against the real model |
| Private workspace, device | Run on the hosted site on Gemini Nano on 2026-11-16, and in 21 evaluation rounds on the device (the last six clean: no unsafe proposals) |
| Store file | Generated from the current model |
| Not covered yet | Changes of owner or recipient; a second tab on the same store (`storage locked`); splitting a long note with many commitments |

The free tier allows 500 cloud requests a day for the model, and an evaluation run uses about 50; if the hosted demo's cloud reading fails, the day's quota may be spent.

## Documentation

| File | What it holds |
|---|---|
| `docs/decisions.md` | Product definition, platform, privacy and inference policy |
| `docs/data-model.md` | The commitment model, its write rules and the core questions as queries |
| `docs/linking-experiment.md` | Whether a model attaches a note to the right commitment, on the device and in the cloud |
| `docs/evaluation.md` | Capture measured end to end, round by round |
| `docs/slice-results.md` | What the feasibility slice tested and found |

## How this was built

- **Start.** The first commit is dated 2026-11-14, within both contest periods. The research behind it began the same day.
- **Reused code.** None. All code here was written for this project, starting 2026-11-14; the only code not written for it is the third-party packages listed below.
- **Third-party.** Relate (`@relate/relate-wasm`, `@relate/relate`), the Firebase JS SDK (AI Logic, App Check, Hosting), Vite, Playwright (evaluation only).
- **AI assistance.** Substantial. The research notes, the documents in `docs/` and most of the code and tests were written with Claude Code (Anthropic) under the author's direction. Implementation and tests were reviewed with OpenAI Codex, whose findings were reproduced and fixed with tests. The author ran every browser and device experiment, supplied the results, and made the product decisions.

## License

Apache-2.0. See `LICENSE`.
