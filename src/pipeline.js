// Reading one note, from text to proposals and cards: the linking call, then
// the dependency call when the note has a word that states one. Shared by the
// review screen and the evaluation, so both run exactly the same path.
//
// `generate(prompt, schema)` makes one model call and returns
// {parsed, ms, source}; the page passes the cloud call, tests pass a fake.

import * as capture from './capture.js';
import { findSimilarNotes } from './model.js';
import * as dependencies from './dependencies.js';
import { variants } from './linking-cases.js';

// Returns
//   out        capture.capture's result (session, recorded, pending, ...)
//   pending    every card the note needs: from the linking answer, then the dependency answer
//   proposed   proposals made at once
//   linking    {ms, source, parsed} of the linking call
//   deps       {ms, parsed, waiting, proposed, problems} of the dependency call, or
//              {error} when it failed (the note is stored either way), or null when not made
//   leftOut, similarBefore  for the status line
// shape: 'v2' (one list, for the cloud model) or 'v1' (two lists, for the
// device model with the app rules); see docs/linking-experiment.md.
export async function readNote(q, { text, kind = 'note', occurredAt, baseDate, generate, extractedBy = 'model', now, shape = 'v2' }) {
  const ready = await capture.prepare(q, text);
  const similarBefore = (await findSimilarNotes(q, text)).length > 0;
  const variant = variants[shape];
  // Nothing is stored until the model has answered.
  const linking = await generate(variant.buildPrompt(text, ready.candidates), variant.buildSchema(ready.candidates));
  const out = await capture.capture(q, {
    text, kind, occurredAt, baseDate, answer: linking.parsed, shape,
    candidates: ready.candidates, people: ready.people, extractedBy, ...(now ? { now } : {}),
  });
  const pending = [...out.pending];
  let proposed = out.recorded.added.length;

  let deps = null;
  const list = out.usable && dependencies.hasCue(text) ? capture.dependencyList(ready.candidates, out.pending) : [];
  if (list.length) {
    try {
      const read = await generate(dependencies.buildPrompt(text, list), dependencies.buildSchema(list));
      const added = await capture.addDependencies(q, out.session, { answer: read.parsed, list, note: text, people: ready.people });
      // A new card that is a listed commitment said again goes: the dependency
      // is on the listed one.
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const item = pending[i];
        const low = (x) => String(x ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        // Also a new card in the words of a listed commitment a dependency is
        // on, for the same person: "Send the proposal" beside "the proposal
        // waits for pricing".
        const copy = item.type === 'new' && (added.copies?.includes(item.ref)
          || (added.involvedWhat ?? []).some((c) => low(c.what) === low(item.what) && (!low(item.toName) || low(item.toName) === low(c.to))));
        // "I'll send Dana's contract once ..." with a new "Send the contract"
        // asked about as new or the same: the dependency is on the listed one.
        const same = item.type === 'question' && item.options.some((o) => o.type === 'same' && added.involved?.includes(o.commitmentId));
        if (copy || same) pending.splice(i, 1);
      }
      pending.push(...added.pending);
      const direct = added.recorded?.added.length ?? 0;
      proposed += direct;
      deps = { ms: read.ms, parsed: read.parsed, proposed: direct, waiting: added.pending.filter((p) => p.type === 'dependency').length, problems: added.problems };
    } catch (err) {
      deps = { error: err.message };
    }
  }
  await capture.savePending(q, out.session, pending);
  return { out, pending, proposed, linking, deps, leftOut: ready.leftOut, offered: ready.candidates.length, similarBefore };
}
