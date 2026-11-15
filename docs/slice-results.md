# Feasibility slice results

Working name: **Kept** — "Know what you owe. See what changed."

Run with `npm install` then `npm run dev` in the repository root, and open http://localhost:5173/.

Checks refer to the web-core list in `decisions.md`.

## Status

| # | Check | Result |
|---|---|---|
| 1 | Firebase AI Logic on-device call reports `on_device` | **Passed** (2026-11-15) |
| 2 | Schema-constrained JSON through the Firebase SDK | **Passed**, on-device and cloud (2026-11-15) |
| 3 | App Check, hosted and debug token | **Passed** (2026-11-15), including a signed-out Incognito window on the same Mac |
| 4 | Cloud fallback in a browser without the model | **Passed** (2026-11-15), with the model removed from this Chrome |
| 5 | Only-on-device fails visibly with no network request | **Passed with an app-side guard** (2026-11-15). The SDK alone is not enough, see below |
| 6 | Relate persists in a worker and survives a restart | **Passed** for page reload (2026-11-14) and for a full Chrome restart (2026-11-15, by the user on Windows, Chrome 157) |
| 7 | Inspectable store file generated from the same seed data | **Passed** (2026-11-15): generated with the Node binding, opened with the Relate CLI, and the browser loads the same seed |

## Relate in the browser (check 6)

Tested 2026-11-14 on the development Mac, Chrome 157 stable, `@relate/relate-wasm` 1.0.1, Vite 5.4.

| Test | Result |
|---|---|
| Engine loads in a dedicated module worker, store `opfs://kept` opens | Works; engine reports version 1.0.1 |
| Write a commitment with its evidence in one statement | Works |
| Reload the page and read it back | The commitment and evidence text are still there |
| Malformed Cypher | Returns a readable syntax error; the engine stays usable |
| Second worker opens the same store | Refused with `storage locked: opfs://kept`; the first handle keeps working |
| Full-text index on evidence text, queried for "pricing" | Works through `db.index.fulltext.queryNodes` |
| Store size after one commitment | About 11 KB of origin storage |

### Full Chrome restart (2026-11-15)

Run by the user on a Windows machine, Chrome 157: demo data loaded, Chrome quit and reopened, then "Ask the graph" without loading the demo data again. The seeded rows were still there. This is also the first Relate result on Windows; everything earlier was on Macs.

The table showed the "Send proposal" row four times. That is not a persistence fault: the seed statement in `src/seed.js` uses `CREATE` for the commitments, so every click on "Load demo data" adds another copy. `loadSeed` in `src/graph.js` now skips seeding when the demo commitment already exists. The guard has not been run in a browser and is not deployed to the hosted site yet.

### The demo question runs as plain Cypher

The three-note scenario from `decisions.md` was loaded by hand: a proposal owed to Dana, blocked by pricing owed by Lee, with a deadline moved from Nov 20 to Nov 24.

One query for "what needs my attention" returned the open commitment, its current due date, the superseded date, the blocker and who it is waiting on:

| what | due | previouslyDue | blockedBy | waitingOn |
|---|---|---|---|---|
| Send proposal | 2026-11-24 | 2026-11-20 | Confirm pricing | Lee |

A quantified path pattern (`-[:BLOCKED_BY]->+`) returned the dependency chain. So the graph can compute the answer without a model; the model's job is extraction and explanation, as `decisions.md` argues.

Model used in the test (hand-written, not final):

- `(:Person)-[:OWES]->(:Commitment)-[:TO]->(:Person)`
- `(:Commitment)-[:BLOCKED_BY]->(:Commitment)`
- `(:Commitment)-[:HAS_DEADLINE]->(:Deadline)`, `(:Deadline)-[:SUPERSEDES]->(:Deadline)`
- `(:Commitment)-[:EVIDENCED_BY]->(:Evidence)`

### Design consequences confirmed

- The single-handle rule is real: a second tab cannot open the store. The app needs one owning tab or a shared hand-off; the slice only reports the lock.
- `reset()`, worker restart and error handling behave as documented.

## Firebase AI Logic hybrid extraction (checks 1, 2, 5)

Tested 2026-11-15, same Mac and Chrome 157, Firebase JS SDK 13.3.0, project `relate-hybrid` on the Spark plan with the Gemini Developer API backend. Chrome reported the device model as `available` before the run. Asked through the raw Prompt API later the same day, after the model was re-downloaded, it answered "I am Gemma 4", which matches the Gemma 4 flag being on. `chrome://on-device-internals` showed `gemma4_component` 2026.8.7.929 Ready, with `nano_v3_gpu_component` 2025.8.8.1141 also Ready and the 4B and 12B Gemma assets not installed. With both installed, the asset list alone does not say which one answers; the self-identification does. Per the user's observation, the order with Gemma 4 enabled (the user names the setting `prompt_api_gemma4`) is:

1. Chrome downloads and enables `gemma4_component`.
2. Prompts work from that point.
3. Chrome then starts downloading `nano_v3_gpu_component` in the background.

So Nano 3 being present does not mean the flag is off, and prompting does not wait for it.

The note was "I'll send Dana the proposal Friday, once Lee confirms pricing." One run per mode.

| Mode | Answered by | Time | Requests to Google APIs |
|---|---|---|---|
| Only on-device | `on_device` | 6.3 s | None |
| Prefer on-device | `on_device` | 3.4 s | None |
| Only cloud | `in_cloud` | 1.2 s | One `generateContent` call |
| Prefer cloud | `in_cloud` | 1.2 s | One `generateContent` call |

- Both sides returned valid JSON matching the schema: one commitment, "send the proposal", owner "me", to "Dana", due "Friday".
- Quality difference on this note: the cloud model set `waitingOn` to "Lee"; the device model put "Lee confirms pricing" in both `waitingOn` and `blockedBy`. The on-device prompt or schema needs tightening.
- One JSON Schema serves both sides: `responseConstraint` on the device and `responseJsonSchema` in the cloud.
- Prefer-cloud falls back to the device when the cloud call fails (seen while the cloud path was still blocked). A cloud outage is therefore silent unless the UI shows the source.
- Requests were counted by wrapping `fetch` in the page, not by reading the DevTools network panel.

### App Check (check 3, debug token half)

- The project enforces App Check for AI Logic: without a token the cloud call returns `401 Firebase App Check token is invalid`.
- On localhost the slice uses a debug token, generated per browser, kept in `localStorage` and registered by hand in the console (App Check > Apps > app menu > Manage debug tokens). This worked with no attestation provider registered for the app.
- Not done: a real provider (reCAPTCHA Enterprise) for the hosted build. Judges cannot use debug tokens, so the hosted cloud path does not work yet.

### Without the device model (checks 4 and 5)

Tested 2026-11-15 after the user removed the local models; Chrome reported the model as `downloadable`.

| Mode | Result | Requests to Google APIs |
|---|---|---|
| Prefer on-device | `in_cloud`, 1.5 s, correct answer | One `generateContent` call |
| Prefer cloud | `in_cloud`, 1.2 s | One `generateContent` call |
| Only on-device, SDK alone, scripted click | Error: "Requires a user gesture when availability is downloading or downloadable" | None |
| Only on-device, with the app guard | Error: "The device model is not ready (downloadable). Nothing was sent anywhere." | None |

- Neither prefer mode started a model download; availability stayed `downloadable`.
- **Prefer on-device sends the note to the cloud when the model is missing**, with nothing but `inferenceSource` to show it. Private notes must use only-on-device, as `decisions.md` argues.
- **Only-on-device in the SDK does not fail fast on a real click.** Reading SDK 13.3.0: when the model is `downloadable` it goes on to `LanguageModel.create()`, which with a user gesture starts the multi-gigabyte download and waits for it. The scripted test only failed because it carried no gesture. This was read from the source, not run, to avoid re-downloading the model.
- `src/ai.js` now checks availability first and refuses only-on-device unless the model is `available`. The guard does not depend on a gesture, but it was exercised by a scripted click only.

### Prompt tightening and note-to-graph (2026-11-15)

The prompt now carries three worked examples (a blocked commitment, one owed by someone else, a note with none). Six notes were run only-on-device, one run each, 2.6 to 3.4 s per note:

| Note | On-device result |
|---|---|
| Proposal to Dana, once Lee confirms pricing | Correct; `waitingOn` is now "Lee" |
| Review Priya's deck by Wednesday | Correct |
| Sam will send me the contract; I book the venue once Maria approves | Sam's commitment correct. **The venue commitment was dropped**, and `blockedBy` held a stray quote mark |
| Two notes with no commitment | Correctly empty (the first prompt invented one) |
| Jo fixes the login bug before the release; I owe Ben feedback | Both found. **"before the release" landed in `blockedBy`** instead of `due` |

The cloud model got the first four right with the earlier prompt, in about 1 s each. So the device model is usable for single-commitment notes and unreliable on notes with two; that is a candidate for the "escalate to cloud" story, or for splitting notes by sentence first.

`src/graph.js` writes an extraction to the graph in one statement (evidence, people, commitments, deadline text, blocker and who owes it), all marked `unreviewed`. The statement and the attention query were run against the Node binding and returned the expected rows. In Chrome, "Extract and save" in only-on-device mode stored the Dana note with no network request, and the attention table showed it (Send the proposal, unreviewed, due Friday, blocked by "Confirms pricing", waiting on Lee). "Load demo data" added the seeded scenario beside it, and both rows were still there after a page reload.

Seen along the way: a second tab on the page held the store, and this tab failed with `storage locked` until the other was closed. The app needs to handle that case rather than just fail to open.

## Hosted build (2026-11-15)

Deployed to Firebase Hosting at https://relate-hybrid.web.app with `npx firebase-tools deploy --only hosting` from this repository (config in `firebase.json`, build in `dist/`).

| Test on the hosted site, Chrome 157 | Result |
|---|---|
| Relate store opens in the worker | Works; a separate, empty store, since it is a different origin from localhost |
| Load demo data, ask the graph | Returns the seeded row |
| Extract and save, only on-device | `on_device`, 5.9 s, saved, no network request |
| Only cloud, before a provider was registered | Fails: `401 Firebase App Check token is invalid` |
| Only cloud and prefer cloud, with reCAPTCHA Enterprise | `in_cloud`, about 1 s, correct answer |

App Check on the hosted site:

- A score-based reCAPTCHA Enterprise website key ("Kept web (App Check)") was created in the `relate-hybrid` project with `gcloud recaptcha keys create`, limited to `relate-hybrid.web.app` and `relate-hybrid.firebaseapp.com`. This needed the reCAPTCHA Enterprise API enabled; no billing account was required.
- The key was registered in App Check by hand in the console, with the default risk threshold of 0.5. `src/ai.js` uses `ReCaptchaEnterpriseProvider` off localhost and the debug token on it.
- Tested in the developer's own Chrome profile, and by the user in an Incognito window on the same Mac: only-cloud answered `in_cloud` in 1.0 s with the correct commitment. The device model was reported as available in Incognito too. A different Mac was tried later the same day, see "Second Mac" below.
- Hosting served `index.html` with a one-hour cache, so the browser kept the old bundle after a redeploy. `firebase.json` now sends `no-cache` for the page.

## Second Mac (2026-11-15)

Run by the user on a different Mac, one run per mode, with the same note ("I'll send Dana the proposal Friday, once Lee confirms pricing."). The device model that answered was Gemma 4, per the user. Not recorded: the Mac model, the Chrome version, and whether the page was the hosted site or localhost.

| Mode | Answered by | Time | Requests to Google APIs |
|---|---|---|---|
| Prefer on-device | `on_device` | 1.9 s | None |
| Only on-device | `on_device` | 1.8 s | None |
| Prefer cloud | `in_cloud` | 1.0 s | One `generateContent` call (`gemini-3.5-flash-lite`) |
| Only cloud | `in_cloud` | 1.0 s | One `generateContent` call (`gemini-3.5-flash-lite`) |

- All four returned valid JSON with no parse error and the same single commitment: owner "me", to "Dana", due "Friday", `waitingOn` "Lee".
- The only difference is wording: the device model wrote "send the proposal" and "confirms pricing"; the cloud model wrote "Send the proposal" and "Confirm pricing", the imperative form the schema asks for.
- The on-device runs were faster than on the development Mac (1.8 to 1.9 s against 2.6 to 6.3 s there).
- Relate: after "Load demo data", "Ask the graph" returned the seeded row (Send proposal, open, due 2026-11-24, previously 2026-11-20, blocked by "Confirm pricing", waiting on Lee), the same as on the development Mac.
- The cloud calls succeeded, so App Check passed on this machine as well.

## Store file for the repository (check 7)

- `npm run seed-store` in the repository root writes `store/kept.rl` (single-file store, 36 KB) with `@relate/relate` 1.0.1, the Node binding. No CLI needed to build it.
- The data comes from `src/seed.js`: the three-note scenario as 3 people, 2 commitments, 2 deadlines and 3 evidence notes.
- A second process reopened the file read-only and counted the 10 nodes. The attention query returned the same row as the hand-loaded browser test above.
- The Relate CLI 1.0.1 opens the file: `relate -d store/kept.rl "<query>"` returned the same attention row.

## To do

- [ ] Ask the organisers whether "Gemini Nano 4" is required strictly, given that Gemma 4 in Chrome needs the `chrome://flags/#gemma4-for-built-in-ai` flag and default Chrome serves Nano 3. Where: Devpost Discord, `#hackathon-help`, tag `#BuildHybridAI`. Check their FAQ, Updates and Discussions tabs first; none of them has been read yet.

## Environment notes

- Node.js v26.13.1 was installed with Homebrew for this slice.
- npm skipped esbuild's install script under its install-script policy; Vite's dev server runs regardless. `vite build` succeeds (2026-11-15).
- The Relate CLI 1.0.1 is installed at `~/.local/bin/relate` (2026-11-15). The installer script was read first; it verifies a signed checksum manifest against a pinned key. Telemetry was turned off with `relate telemetry off` before any other command.
