# Decisions

The decisions the rest of the documentation refers to, with the reason for each. They come from the research and reviews done between 2026-11-14 and 2026-11-15. Where something was measured, the document that holds the measurement is named.

## Product

> A private commitment memory that explains who owes what, what changed, and what is blocked, with evidence from the original conversation.

The job is narrow on purpose: turn passages from messages and meeting notes into an evidence-backed view of commitments. It is not a general personal CRM.

Core questions the app has to answer:

1. What do I owe before Friday?
2. Which commitments are waiting on someone else?
3. What changed since the last client meeting?
4. Why does the app think this is my responsibility?

Each commitment needs an owner, a deadline where known, a status, the source passage, capture and source dates, and links to dependencies and to statements that supersede earlier ones. Ambiguous owners or dates become review items. What a model extracted stays distinguishable from what the user confirmed.

The graph earns its place through dependency traversal, evidence across several notes, and changes over time. Current state and blockers are computed by graph queries, not by a model.

### Demonstration scenario

1. Monday: "I'll send Dana the proposal Friday, once Lee confirms pricing."
2. Wednesday: "Lee's pricing is delayed until Monday."
3. Thursday: "Dana agreed we can send the proposal Tuesday."

Asked "What needs my attention before Friday?", the answer should recognise the superseded deadline, expose the pricing dependency, and link each conclusion to its evidence.

## Platform

**A web app in desktop Chrome.** It is the one platform where both pieces are released and documented: Relate's WebAssembly build with a persistent store, and Firebase AI Logic's on-device inference through Chrome's built-in model.

Consequences that shaped the design:

- Relate's browser build persists only to OPFS and only from a dedicated worker. One handle owns the store, so a second tab cannot open it.
- Every on-device call is single-turn with a context of 9216 tokens, and there is no tool calling on the device. Conversation state lives in the graph, and retrieval is done by application code.
- There are no on-device embeddings. Retrieval starts with full-text search and graph traversal.

## The device model

- Chrome serves Gemini Nano 3 by default. Gemma 4 ("Nano 4") needs the flag `chrome://flags/#gemma4-for-built-in-ai` set to Enabled. Enabling Gemma 4 in `chrome://on-device-internals` alone is not enough: without the flag, Nano 3 answers every call.
- With the flag on, Chrome downloads `gemma4_component`, prompts work from then on, and Nano 3 may still be downloaded in the background. Its presence does not mean the flag is off.
- To check which model is answering, ask it through the raw Prompt API. The linking page does this on load.
- The app has to work on Nano 3 and on the cloud fallback, since that is what a default Chrome gives.

Measured in `slice-results.md`.

## Privacy and inference

- **Two workspaces, two stores, two policies.** Demo data and private data live in separate OPFS stores (`opfs://kept-demo`, `opfs://kept-private`). The inference policy is bound to the active workspace. Storage separation alone does not control where a note is sent.
- **Demo workspace:** prefer-on-device, falling back to the cloud, so the hosted demo works on any machine. The source of each answer is shown.
- **Private workspace:** only-on-device by default. Prefer-on-device must not be used for private notes: when the device model is missing it sends the note to the cloud, with nothing but the reported source to show it (measured in `slice-results.md`). The app checks model availability itself before an only-on-device call, because the SDK alone would start a multi-gigabyte download instead of failing.
- **Cloud assistance for private notes** is an explicit opt-in, after showing exactly what will be sent.
- Replacing names is pseudonymisation and data minimisation, not anonymisation.

## The model of commitments

In `data-model.md`. In short:

- The commitment holds the accepted state, and only that.
- Every change is a record of its own. A model's suggestion is a proposal that does nothing until the user accepts it.
- Each current value points at the change that set it.
- "What changed" means what the app learned since, named that way in the interface, with the source time shown.

## Linking a note to existing commitments

In `linking-experiment.md`. Decided on 2026-11-15:

| Where | Linking runs | Shown as |
|---|---|---|
| Demo workspace | In the cloud | Proposals to confirm |
| Private workspace | On the device | Provisional proposals to confirm, with the alternatives visible |
| Private workspace, cloud assistance | In the cloud, only after an opt-in that shows the note and the candidate commitments being sent | Proposals to confirm |
| Demo workspace, "read on this device when its model is ready" (added 2026-11-18, off by default) | Prefer-on-device: on the device when Chrome's model is ready, else in the cloud; a device call that fails or takes over 45 s is retried in the cloud | Provisional when the device answered; the status line says which model answered and why the cloud stood in |

On both routes a model's answer is validated, becomes proposals, and changes accepted state only when the user confirms. A clean answer does not establish an unambiguous link, and a model asking when unsure does not justify accepting anything automatically.

## Feasibility checks

The web-core checks that `slice-results.md` reports against:

1. A Firebase AI Logic call in prefer-on-device mode, with the Gemma 4 flag on, reports `on_device`.
2. Schema-constrained JSON for a commitment through the Firebase SDK, not the raw Prompt API.
3. App Check passes with reCAPTCHA Enterprise on the hosted URL, and with a debug token in development.
4. In a browser without the local model, the hosted page falls back to the cloud for the demo data.
5. Only-on-device fails visibly, with no network request, when the model is unavailable.
6. A commitment persisted in Relate's WebAssembly build inside a dedicated worker survives a Chrome restart, with its evidence.
7. The inspectable store file in the repository is generated from the same seed data as the browser store, and opens with the Relate CLI.

## Schedule

| Dates | Work |
|---|---|
| Nov 14 to 17 | Feasibility slice; commitment and evidence model; the core questions |
| Nov 18 to 23 | Capture, review and correction; graph answers for the core questions |
| Nov 24 to 26 | Cloud assistance with payload preview; answer-specific graph view; demo dataset |
| Nov 27 to 29 | Hosting, documentation, video |

## Open before private-data use

Closed on 2026-11-18:

- **The rules on the browser build.** `npm run test:wasm` runs the whole suite on Relate's WebAssembly build, in a dedicated worker on an OPFS store, in headless Chromium (`test/store.mjs`), the same path as the app. All 200 tests pass there as on the Node binding. It found one difference: Cypher's `randomUUID()` traps the WebAssembly build (it has no clock), so ids are made in JavaScript.
- **Atomic rejection.** Rejecting a commitment that other things depend on is now one statement, which commits whole or not at all. It re-checks inside the statement that the consequences are the ones the user confirmed; if they changed, nothing is written and the outcome is `busy`.
- Matching the people named in a new commitment, resolving dates such as "Friday" (only when they have one reading), and choosing candidate commitments from a larger store are built, in `src/capture.js`.
