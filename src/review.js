// The review screen, for one of two workspaces, each with its own store
// (docs/linking-experiment.md, "Routing"):
//   demo     (default)  notes are read by the cloud model with prompt v2; the
//                       demo scenario can be loaded. With "read on this device
//                       when its model is ready" on, Firebase AI Logic's
//                       prefer-on-device is used, with prompt v1, and the
//                       cloud stands in when the device model is not there
//   private  (?workspace=private)  notes are read by the model built into this
//            browser with prompt v1 and the app rules, and do not leave the
//            device; what it proposes is provisional. The cloud model is used
//            for a note only when the user ticks the box, after seeing exactly
//            what would be sent
// Every write goes through the rules in model.js; nothing is accepted without
// the user.

import * as db from './db.js';
import * as m from './model.js';
import * as data from './review-data.js';
import * as capture from './capture.js';
import * as ai from './ai.js';
import * as pipeline from './pipeline.js';
import { readBy } from './hybrid.js';

const PRIVATE = new URLSearchParams(location.search).get('workspace') === 'private';
const STORE = PRIVATE ? 'opfs://kept-private' : 'opfs://kept-demo';
const START_HINT = PRIVATE ? 'Capture a note or add a person first.' : 'Load the demo scenario or capture a note first.';
const $ = (id) => document.getElementById(id);
const q = (statement, params) => db.query(statement, params);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node[key] = value;
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function table(columns, rows, empty) {
  if (!rows.length) return el('p', { class: 'muted' }, empty);
  return el('table', {},
    el('tr', {}, columns.map(([title]) => el('th', {}, title))),
    // data-label: the column's title, shown inline where rows are stacked (narrow panels, phones).
    rows.map((row) => el('tr', {}, columns.map(([title, cell]) => el('td', { 'data-label': title || null }, cell(row) ?? '')))));
}

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'date unknown');
// The words and the date, once when they are the same ("2026-11-20", not "2026-11-20 (2026-11-20)").
const dueOf = (due, dueText) => (due && dueText && dueText.trim() !== due ? `${dueText} (${due})` : due || dueText || '');

// The note with the quoted words marked, so the claim can be checked against its source.
function quoted(text, quote) {
  const start = quote ? text.toLowerCase().indexOf(quote.toLowerCase()) : -1;
  if (start < 0) return [text];
  return [text.slice(0, start), el('mark', {}, text.slice(start, start + quote.length)), text.slice(start + quote.length)];
}

const OUTCOME = {
  applied: 'Applied.',
  recorded: 'Kept as history only: it is older than the current value, which was left as it is.',
  rejected: 'Rejected.',
  stale: 'The value this was proposed against has changed since. Look at the commitment as it is now, then apply it anyway or reject it.',
  cycle: 'Not applied: these two commitments would each wait for the other.',
  'needs-confirmation': 'This commitment already has decisions on it, or another commitment depends on it. Rejecting it removes those too.',
  'not-proposed': 'This was already decided.',
  missing: 'This proposal no longer exists.',
  busy: 'The store was busy. Try again.',
  'not-movable': 'This kind of change cannot be moved to another commitment.',
};

let me = null;
let commitmentRows = [];
let personRows = [];
// What captured notes still need from the user. Kept in the page only: a
// reload loses these, and the notes they came from stay in the store.
const pendingItems = []; // { session, noteText, item, error }
let loadedPending = false;
const messages = new Map(); // changeId -> { outcome, text }
const decided = []; // what was done in this session, newest first: { summary, text }
const summaries = new Map(); // changeId -> the sentence shown on its card

async function act(changeId, work) {
  try {
    const result = await work();
    if (result.text) {
      messages.set(changeId, { outcome: result.outcome, text: result.text });
      await refresh();
      return;
    }
    const extra = result.outcome === 'needs-confirmation'
      ? ` ${[...result.decisions.map((d) => `a ${d.kind} change`), ...result.dependents.map((d) => `"${d.what}" depends on it`)].join('; ')}.`
      : '';
    messages.set(changeId, { outcome: result.outcome, text: (OUTCOME[result.outcome] ?? result.outcome) + extra });
  } catch (err) {
    messages.set(changeId, { outcome: 'error', text: `Error: ${err.message}` });
  }
  await refresh();
}

function card(item) {
  const message = messages.get(item.changeId);
  const others = commitmentRows.filter((c) => c.id !== item.commitment.id && c.status === 'open');
  const movable = ['deadline', 'completed', 'cancelled', 'reopened', 'evidence'].includes(item.kind) && others.length > 0;
  const target = el('select', {}, others.map((c) => el('option', { value: c.id }, `${c.what} (${c.owner}${c.to ? ` to ${c.to}` : ''})`)));
  return el('div', { class: 'card' },
    el('div', { class: 'summary' }, item.summary,
      item.stale && el('span', { class: 'flag' }, 'out of date'),
      item.conflicts && el('span', { class: 'flag' }, 'another proposal wants the same value')),
    item.note
      ? [el('blockquote', {}, quoted(item.note.text, item.quote)),
        el('div', { class: 'source muted' }, `From a ${item.note.kind}, ${when(item.note.occurredAt)}. ${item.note.extractedBy === 'device'
          ? 'Read by the model on this device: provisional. Check that it is about this commitment and not another one.'
          : 'Read from the note, not confirmed by you.'}`)]
      : el('div', { class: 'source muted' }, 'No source note.'),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: () => act(item.changeId, () => m.accept(q, item.changeId)) }, 'Accept'),
      el('button', { class: 'quiet', onclick: () => act(item.changeId, () => m.reject(q, item.changeId)) }, 'Reject'),
      message?.outcome === 'stale' && el('button', { onclick: () => act(item.changeId, () => m.accept(q, item.changeId, { confirmStale: true })) }, 'Apply anyway'),
      message?.outcome === 'needs-confirmation' && el('button', { onclick: () => act(item.changeId, () => m.reject(q, item.changeId, { confirmConsequences: true })) }, 'Reject and remove those too'),
      movable && [' It is about another commitment: ', target,
        el('button', { onclick: () => act(item.changeId, async () => {
          const where = target.selectedOptions[0]?.textContent ?? 'the other commitment';
          const result = await data.moveProposal(q, item.changeId, target.value);
          // Say what was done, not what was proposed: the proposal itself was rejected.
          return result.outcome === 'applied' ? { ...result, text: `Rejected as proposed. Applied to ${where} instead.` } : result;
        }) }, 'Apply there')]),
    message && el('div', { class: `message ${message.outcome === 'error' ? 'bad' : ''}` }, message.text));
}

async function refresh() {
  const [items, list, persons] = [await data.reviewItems(q), await data.commitments(q), await data.people(q)];
  commitmentRows = list;
  personRows = persons;
  me = persons.find((p) => p.isMe) ?? null;
  renderPending();

  // A message stays on its card while the proposal is open. Once the proposal
  // is gone, what was decided moves to the list below, so it stays visible.
  const open = new Set(items.map((i) => i.changeId));
  for (const [id, message] of [...messages]) {
    if (open.has(id)) continue;
    decided.unshift({ summary: summaries.get(id) ?? 'A proposal', text: message.text });
    messages.delete(id);
  }
  for (const item of items) summaries.set(item.changeId, item.summary);

  $('review-count').textContent = items.length ? `(${items.length})` : '';
  $('review').replaceChildren(
    ...(items.length ? items.map(card) : [el('p', { class: 'muted' }, 'Nothing is waiting for review.')]));
  $('decided').replaceChildren(...(decided.length
    ? [el('h2', {}, 'Decided in this session'), table([['Proposal', (d) => d.summary], ['Result', (d) => d.text]], decided, '')]
    : []));

  $('commitments').replaceChildren(table([
    ['What', (c) => c.what],
    ['Owner', (c) => c.owner],
    ['For', (c) => c.to],
    ['Due', (c) => dueOf(c.due, c.dueText)],
    ['Status', (c) => (c.review === 'unreviewed' ? `${c.status}, not confirmed` : c.status)],
    ['Waiting for review', (c) => (c.pendingChanges ? `${count(c.pendingChanges, 'change')}` : '')],
    ['', (c) => el('button', { onclick: () => why(c) }, 'Why?')],
  ], list, PRIVATE ? 'No commitments yet. Capture a note to start.' : 'No commitments yet. Load the demo scenario, or capture a note.'));

  const summary = await data.peopleSummary(q);
  const counts = (p) => [p.owes && `owes ${p.owes}`, p.owed && `owed ${p.owed}`].filter(Boolean).join(', ');
  $('people-list').replaceChildren(...(summary.length
    ? summary.map((p) => el('div', {}, el('strong', {}, p.isMe ? `${p.name} (you)` : p.name), counts(p) ? `: ${counts(p)}` : ''))
    : ['No people yet. They are added by the first note, or by hand above.']));

  const select = $('person');
  const chosen = select.value;
  select.replaceChildren(...persons.filter((p) => !p.isMe).map((p) => el('option', { value: p.id }, p.name)));
  if (chosen) select.value = chosen;
  // "open" stays in the text: scripts wait for it before they start.
  $('status').replaceChildren(el('span', {}, `Kept in this browser (store open): ${list.length} commitment${list.length === 1 ? '' : 's'}, ${items.length} waiting for review.`));
}

const pending = (n) => (n ? `${count(n, 'change')} waiting for review` : '');
const answer = (id, ...nodes) => $(id).replaceChildren(...nodes);
const needMe = (id) => {
  if (!me) answer(id, el('p', { class: 'muted' }, START_HINT));
  return Boolean(me);
};
const guard = (id, work) => async () => {
  try {
    await work();
  } catch (err) {
    answer(id, el('p', { class: 'bad' }, `Error: ${err.message}`));
  }
};

$('ask-owe').onclick = guard('answer-owe', async () => {
  if (!needMe('answer-owe')) return;
  const rows = await m.owedBefore(q, { personId: me.id, date: $('before').value });
  answer('answer-owe', table([
    ['What', (c) => c.what],
    ['Due', (c) => dueOf(c.due, c.dueText) || 'no date'],
    ['', (c) => [c.review === 'unreviewed' ? 'not confirmed' : '', pending(c.pendingChanges)].filter(Boolean).join('; ')],
  ], rows, 'Nothing is due by then.'));
});

$('ask-waiting').onclick = guard('answer-waiting', async () => {
  if (!needMe('answer-waiting')) return;
  const rows = await m.waitingOn(q, { personId: me.id });
  answer('answer-waiting', table([
    ['What', (w) => w.what],
    ['Waits for', (w) => `${w.blockedBy}${w.blockerStatus === 'cancelled' ? ' (cancelled)' : ''}`],
    ['Owed by', (w) => w.waitingOn],
    ['Their deadline', (w) => w.blockerDue ?? 'none set'],
  ], rows, 'Nothing is waiting on anyone else.'));
});

$('ask-owed').onclick = guard('answer-owed', async () => {
  if (!needMe('answer-owed')) return;
  const rows = await m.owedTo(q, { personId: me.id });
  answer('answer-owed', table([
    ['What', (c) => c.what],
    ['Owed by', (c) => c.owedBy],
    ['Due', (c) => dueOf(c.due, c.dueText) || 'no date'],
    ['Holds up', (c) => c.holdsUp.join(', ') || ''],
    ['', (c) => [c.review === 'unreviewed' ? 'not confirmed' : '', pending(c.pendingChanges)].filter(Boolean).join('; ')],
    ['', (c) => el('button', { onclick: () => why({ id: c.id, what: c.what }) }, 'Why?')],
  ], rows, 'Nobody owes you anything open.'));
});

$('ask-changed').onclick = guard('answer-changed', async () => {
  const personId = $('person').value;
  if (!personId) {
    answer('answer-changed', el('p', { class: 'muted' }, START_HINT));
    return;
  }
  const baseline = await m.meetingBaseline(q, { personId, previous: $('previous').value === 'before' });
  if (!baseline) {
    answer('answer-changed', el('p', { class: 'muted' }, 'There is no meeting with this person in the store.'));
    return;
  }
  const rows = await data.changesWithCommitments(q, { since: baseline.since, baselineNoteId: baseline.noteId });
  answer('answer-changed',
    el('p', { class: 'muted' }, `What the app has learned since the meeting of ${when(baseline.since)}`
      + `${baseline.boundaryUncertain ? ' (its time of day is unknown, so this includes everything from that day)' : ''}. `
      + 'The meeting\'s own notes are left out.'),
    table([
      ['Learned', (c) => when(c.learned)],
      ['Happened', (c) => (c.happened ? when(c.happened) : 'unknown')],
      ['What', (c) => c.summary],
      ['', (c) => (c.state === 'proposed' ? 'waiting for review' : c.applied ? 'accepted' : 'accepted, history only')],
    ], rows, 'Nothing has been learned since then.'));
});

async function why(commitment) {
  try {
    const { current, pending: proposals } = await m.whyOwner(q, { commitmentId: commitment.id });
    const basis = current.source === 'manual'
      ? 'You set this yourself.'
      : [`${current.state === 'accepted' ? 'Confirmed' : 'Not confirmed yet'}. Read from a note of ${when(current.said)}:`, el('blockquote', {}, quoted(current.note ?? '', current.quote))];
    const past = await data.historyItems(q, commitment.id);
    const decided = (h) => (h.derived ? `follows from "${h.blocker}"` : h.state === 'proposed' ? 'waiting for review'
      : h.state === 'rejected' ? 'rejected'
        : h.source === 'manual' ? 'set by you' : h.applied ? 'accepted' : 'accepted, history only');
    answer('answer-why',
      el('p', {}, el('strong', {}, `"${commitment.what}" is ${current.owner === 'Me' ? 'yours' : `${current.owner}'s`}. `), basis),
      proposals.map((p) => el('p', { class: 'muted' }, `Waiting for review: a note says ${p.proposedOwner} should own it ("${p.quote ?? ''}").`)),
      el('h3', {}, 'History'),
      past.length
        ? el('ol', { class: 'timeline' }, past.map((h) => el('li', { class: h.derived ? 'derived' : h.state },
          el('div', { class: 'when' }, el('span', {}, when(h.learned)), el('span', { class: 'decision' }, decided(h))),
          el('div', { class: 'what' }, h.summary),
          h.note && el('blockquote', {}, quoted(h.note, h.quote)),
          h.note && h.extractedBy === 'device' && el('div', { class: 'by' }, 'Read on this device')))
        )
        : el('p', { class: 'muted' }, 'No history.'));
    $('answer-why').scrollIntoView({ block: 'nearest' });
  } catch (err) {
    answer('answer-why', el('p', { class: 'bad' }, `Error: ${err.message}`));
  }
}

$('seed').onclick = async () => {
  try {
    const added = await data.seedDemo(q);
    await refresh();
    if (!added) $('status').append(' The store already has commitments; the demo scenario was not loaded. Empty the store first to load it.');
  } catch (err) {
    $('status').replaceChildren(el('span', { class: 'bad' }, `Error: ${err.message}`));
  }
};

$('reset').onclick = async () => {
  const workspace = PRIVATE ? 'private' : 'demo';
  // Name what goes, so the confirmation is read, not clicked through.
  const counted = Object.fromEntries((await q('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n').catch(() => [])).map((r) => [r.label, r.n]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const what = [plural(counted.Commitment ?? 0, 'commitment'), plural(counted.Note ?? 0, 'note'), plural(counted.Person ?? 0, 'person').replace(/persons$/, 'people')];
  if (!window.confirm(`Delete everything in the ${workspace} workspace? ${what[0]}, ${what[1]} and ${what[2]} in this browser will be permanently deleted. This cannot be undone.`)) return;
  try {
    await db.reset();
    messages.clear();
    decided.length = 0;
    pendingItems.length = 0;
    $('capture-status').replaceChildren();
    summaries.clear();
    for (const id of ['answer-owe', 'answer-waiting', 'answer-owed', 'answer-changed', 'answer-why']) answer(id);
    await refresh();
  } catch (err) {
    $('status').replaceChildren(el('span', { class: 'bad' }, `Error: ${err.message}`));
  }
};

// --- Capture ---

const CHANGE_WORDS = { 'new deadline': 'new deadline', done: 'done', cancelled: 'cancelled' };
const personSelect = (chosen, none) => {
  const select = el('select', {}, el('option', { value: '' }, none), personRows.map((p) => el('option', { value: p.id }, p.name)));
  select.value = chosen ?? '';
  return select;
};
// Shows the day the app reads from the words of a date, as they are typed.
const resolvedHint = (input, session) => {
  const hint = el('span', { class: 'muted' });
  const show = () => {
    const day = capture.resolveDate(input.value, session.baseDate);
    hint.textContent = !input.value.trim() ? '' : day ? ` = ${day}` : ' (no single date; the words are kept)';
  };
  input.oninput = show;
  show();
  return hint;
};

// Settles one thing a note still needed: runs `work` if there is any, and
// removes the entry unless the store rules refused what it proposed.
async function settle(entry, work) {
  // An earlier error on this card no longer applies once it is tried again.
  entry.error = null;
  try {
    const result = work ? await work() : null;
    const refused = result?.invalid?.[0];
    if (refused) entry.error = `Not proposed: ${refused.reason}.`;
    else {
      pendingItems.splice(pendingItems.indexOf(entry), 1);
      // The capture line counted this as waiting; it no longer is.
      if (!pendingItems.length) $('capture-status').replaceChildren();
    }
    await persist(entry.session);
  } catch (err) {
    entry.error = err.message;
  }
  await refresh();
}

// Saves a note's cards with the note, after every change to them.
function persist(session) {
  return capture.savePending(q, session, pendingItems.filter((e) => e.session === session).map((e) => e.item));
}

function pendingCard(entry) {
  const { session, noteText, item } = entry;
  const source = el('blockquote', {}, quoted(noteText, item.quote));
  const error = entry.error && el('div', { class: 'message bad' }, entry.error);
  const dismiss = (label) => el('button', { class: 'quiet', onclick: () => settle(entry) }, label);
  const openOnes = commitmentRows.filter((c) => c.status === 'open');
  const become = (next) => () => {
    entry.item = next;
    entry.error = null;
    renderPending();
    persist(session).catch((err) => { entry.error = `Not saved: ${err.message}`; renderPending(); });
  };

  if (item.type === 'new') {
    const what = el('input', { value: item.what ?? '', size: 28, placeholder: 'What is promised' });
    const owner = personSelect(item.ownerId, 'choose…');
    const to = personSelect(item.toId, 'nobody in particular');
    const due = el('input', { value: item.dueText ?? '', size: 12, placeholder: 'no date' });
    const unmatched = [[item.ownerName, item.ownerId], [item.toName, item.toId]].filter(([name, id]) => name && !id).map(([name]) => name);
    return el('div', { class: 'card needs' },
      el('div', { class: 'summary' }, 'A new commitment: who owes it to whom?'),
      source,
      unmatched.length > 0 && el('div', { class: 'source muted' }, `The model named ${unmatched.join(' and ')}, not in your list. Add them above first.`),
      el('div', { class: 'row' }, el('label', {}, 'What ', what), el('label', {}, 'Owed by ', owner), el('label', {}, 'to ', to), el('label', {}, 'due ', due, resolvedHint(due, session))),
      el('div', { class: 'source muted' }, 'The people and the date are how the app reads the words. Correct them before proposing.'),
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: () => settle(entry, () => capture.proposeNew(q, session,
          { what: what.value, ownerId: owner.value, toId: to.value, dueText: due.value.trim(), quote: item.quote, ref: item.ref })) }, 'Propose it'),
        dismiss('Not a commitment')),
      error);
  }

  if (item.type === 'dependency') {
    return el('div', { class: 'card needs' },
      el('div', { class: 'summary' }, `"${item.waiting.what}" cannot be done until "${item.waitsFor.what}" is.`),
      source,
      el('div', { class: 'source muted' }, 'One of these is new in this note. Propose it first (its card is above), then this.'),
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: () => settle(entry, () => capture.proposeDependency(q, session, item)) }, 'Propose it'),
        dismiss('Not a dependency')),
      error);
  }

  // A new commitment the model did not name: the form, with the people and the
  // date the words give, so only "what" is left to type.
  const unnamedNew = (o) => ({ type: 'new', what: '', quote: o.quote, dueText: o.due ?? '', ...capture.guessPeople(o.quote, personRows) });

  if (item.type === 'question') {
    // With no commitment to choose from, "which one?" has a single answer.
    const answers = item.options.filter((o) => o.type !== 'all');
    if (answers.length === 1 && answers[0].type === 'new' && answers[0].incomplete) {
      entry.item = unnamedNew(answers[0]);
      return pendingCard(entry);
    }
    const whatOf = (id) => commitmentRows.find((c) => c.id === id)?.what ?? 'a commitment';
    const changes = item.options.filter((o) => o.type === 'commitment');
    const said = (o) => {
      const day = o.due && capture.resolveDate(o.due, session.baseDate);
      return `${CHANGE_WORDS[o.change]}${o.due ? ` (${o.due}${day ? `, ${day}` : ''})` : ''}`;
    };
    const buttons = item.options.map((o) => {
      if (o.type === 'commitment') return el('button', { onclick: () => settle(entry, () => capture.proposeChange(q, session, [o])) }, `"${whatOf(o.commitmentId)}": ${said(o)}`);
      if (o.type === 'all') return changes.length > 1 && el('button', { onclick: () => settle(entry, () => capture.proposeChange(q, session, changes)) }, 'All of them');
      if (o.type === 'same') return dismiss(`The same thing as "${whatOf(o.commitmentId)}", said twice`);
      // Something new: the card becomes the new-commitment form.
      return el('button', { onclick: become(o.incomplete ? unnamedNew(o) : { ...o, type: 'new' }) }, o.incomplete ? 'Something new' : `New: "${o.what}"`);
    });
    return el('div', { class: 'card needs' },
      el('div', { class: 'summary' }, 'Which commitment does this mean?'),
      source,
      el('div', { class: 'source muted' }, item.from === 'model' ? 'The model could not tell.' : 'The answer fits more than one reading, so the app asks instead of choosing.'),
      el('div', { class: 'actions' }, buttons, dismiss('None of these')),
      error);
  }

  // manual: an entry that failed validation. The user links it by hand.
  const target = el('select', {}, openOnes.map((c) => el('option', { value: c.id }, `${c.what} (${c.owner}${c.to ? ` to ${c.to}` : ''})`)));
  const change = el('select', {}, Object.keys(CHANGE_WORDS).map((key) => el('option', { value: key }, CHANGE_WORDS[key])));
  const due = el('input', { size: 12, placeholder: 'new date' });
  return el('div', { class: 'card needs' },
    el('div', { class: 'summary' }, 'Could not be read: link it by hand'),
    source,
    el('div', { class: 'source muted' }, item.reason),
    openOnes.length > 0 && el('div', { class: 'row' }, el('label', {}, 'It changes ', target), el('label', {}, 'to ', change), el('label', {}, due, resolvedHint(due, session))),
    el('div', { class: 'actions' },
      openOnes.length > 0 && el('button', { class: 'primary', onclick: () => settle(entry, () => {
        if (change.value === 'new deadline' && !due.value.trim()) throw new Error('A new deadline needs a date.');
        return capture.proposeChange(q, session, [{ commitmentId: target.value, change: change.value, due: due.value.trim(), quote: item.quote }]);
      }) }, 'Propose it'),
      item.saidNew
        ? el('button', { onclick: become(item.saidNew) }, `It is new: "${item.saidNew.what}"`)
        : el('button', { onclick: become({ type: 'new', what: '', quote: item.quote, dueText: '', ...capture.guessPeople(item.quote, personRows) }) }, 'It is something new'),
      dismiss('Nothing to do')),
    error);
}

// "1 proposal", "2 proposals".
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderPending() {
  $('pending').replaceChildren(...(pendingItems.length
    ? [el('h2', {}, `Needs your input (${pendingItems.length})`),
      el('p', { class: 'muted' }, `${count(pendingItems.length, 'thing')} from captured notes ${pendingItems.length === 1 ? 'needs' : 'need'} you before ${pendingItems.length === 1 ? 'it' : 'they'} can be proposed. They are kept with their notes until you deal with them.`),
      ...pendingItems.map(pendingCard)]
    : []));
}

const localNow = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$('note-when').value = localNow();
$('cloud-model').textContent = ai.CLOUD_MODEL;
for (const node of document.querySelectorAll('.cloud-model')) node.textContent = ai.CLOUD_MODEL;

// --- Workspace switch and where a note will be read ---

$(PRIVATE ? 'ws-private' : 'ws-demo').setAttribute('aria-current', 'page');
let privateDeviceStatus = null;

// The stamp beside "Read this note": where this note would be read now.
async function showRoute() {
  const stamp = $('route-stamp');
  let kind = 'cloud';
  let text = 'Cloud';
  if (PRIVATE) {
    [kind, text] = $('cloud-opt-in').checked ? ['cloud', 'Cloud, this note only'] : ['device', 'On this device'];
    if (!$('cloud-opt-in').checked && privateDeviceStatus && privateDeviceStatus !== 'available') {
      [kind, text] = ['unavailable', privateDeviceStatus === 'not_answering' ? 'Device not answering' : 'Device not ready'];
    }
  } else if ($('device-first').checked) {
    const ready = !ai.deviceStuck() && (await ai.deviceModelState().catch(() => 'unavailable')) === 'available';
    [kind, text] = ready ? ['hybrid', 'Device first, cloud if needed'] : ['cloud', 'Cloud (device not ready)'];
  }
  stamp.className = `stamp ${kind}`;
  stamp.textContent = text;
}

// --- Private workspace ---

if (PRIVATE) {
  document.title = 'Kept: private';
  $('workspace-intro').textContent = 'Private workspace, kept in this browser.';
  $('seed').hidden = true;
  $('capture-notice').hidden = true;
  $('demo-hybrid').hidden = true;
  $('private-capture').hidden = false;
}

// The device model's state, and a way to download it, which needs a click.
async function showDeviceState() {
  const state = await ai.deviceModelState();
  $('device-state').textContent = {
    available: 'The device model is ready.',
    downloadable: 'The device model is not downloaded yet.',
    downloading: 'The device model is downloading.',
    unavailable: 'This browser has no device model: use the cloud model below, or open the demo workspace.',
  }[state] ?? `Device model: ${state}.`;
  $('prepare-device').hidden = !(state === 'downloadable' || state === 'downloading');
  return state;
}
// Once, when the workspace opens: does the ready model also answer?
async function checkDeviceAnswers() {
  privateDeviceStatus = await showDeviceState();
  if (privateDeviceStatus !== 'available') { showRoute(); return; }
  $('device-state').textContent = 'The device model is ready; checking that it answers…';
  const answers = await ai.deviceResponds();
  privateDeviceStatus = answers ? 'available' : 'not_answering';
  $('device-state').textContent = answers
    ? 'The device model is ready.'
    : "Chrome's on-device model is not answering. Restart Chrome (close every Chrome window), then reload this page. You can still use the cloud model below.";
  showRoute();
}
if (PRIVATE) checkDeviceAnswers();
if (PRIVATE) showRoute();
$('prepare-device').onclick = async () => {
  $('prepare-device').disabled = true;
  try {
    await ai.prepareDeviceModel((progress) => { $('device-state').textContent = `Downloading the device model: ${Math.round((progress?.loaded ?? 0) * 100)}%.`; });
  } catch (err) {
    $('device-state').textContent = `The device model could not be prepared: ${err.message}`;
  }
  $('prepare-device').disabled = false;
  await checkDeviceAnswers();
};

// Before anything goes to the cloud from the private workspace, the page shows
// what would be sent: the note, and the open commitments offered with it.
async function showCloudPreview() {
  const box = $('cloud-preview');
  box.hidden = !$('cloud-opt-in').checked;
  if (box.hidden) return;
  const text = $('note').value.trim();
  const { candidates } = await capture.prepare(q, text);
  box.replaceChildren(...[
    el('div', { class: 'summary' }, `Will be sent to ${ai.CLOUD_MODEL} when you click "Read this note":`),
    el('blockquote', {}, text || '(the note, once you type it)'),
    el('div', { class: 'source muted' }, candidates.length ? 'and these open commitments, so it can tell which one the note is about:' : 'and no commitments: there are none open.'),
    candidates.length > 0 && el('ul', {}, candidates.map((c) => el('li', {}, `${c.what} (${c.owner}${c.to ? ` to ${c.to}` : ''}${c.due ? `, due ${c.due}` : ''})`))),
    el('div', { class: 'source muted' }, 'Nothing else from this workspace is sent. The box unticks itself after this note.'),
  ].filter(Boolean));
}
$('cloud-opt-in').onchange = () => { showCloudPreview().catch(() => {}); showRoute(); };
$('note').addEventListener('input', () => { if ($('cloud-opt-in').checked) showCloudPreview().catch(() => {}); });

// Demo workspace: prefer the device when the user turns it on. Demo data
// only, so falling back to the cloud is allowed here; the private workspace
// never falls back. The choice is remembered in this browser.
const DEVICE_FIRST_KEY = 'kept.demo.deviceFirst';
async function showDeviceFirst() {
  const on = $('device-first').checked;
  $('demo-route').textContent = on
    ? `the note is read by the model built into this browser when it is ready, and sent with your open commitments to the cloud model (${ai.CLOUD_MODEL}) when it is not.`
    : `the note and your open commitments are sent to the cloud model (${ai.CLOUD_MODEL}).`;
  if (!on) { $('device-first-state').textContent = ''; return; }
  const state = await ai.deviceModelState();
  $('device-first-state').textContent = ai.deviceStuck() ? 'The device model is not answering: notes go to the cloud until it does. Restarting Chrome brings it back.' : {
    available: 'The device model is ready: notes are read here.',
    downloadable: 'This browser has not downloaded its model: notes go to the cloud.',
    downloading: 'The device model is downloading: notes go to the cloud until it is ready.',
    unavailable: 'This browser has no device model: notes go to the cloud.',
  }[state] ?? `Device model: ${state}; notes go to the cloud.`;
}
if (!PRIVATE) {
  try { $('device-first').checked = localStorage.getItem(DEVICE_FIRST_KEY) === '1'; } catch {}
  showDeviceFirst().catch(() => {}).then(showRoute);
  $('device-first').onchange = () => {
    try { localStorage.setItem(DEVICE_FIRST_KEY, $('device-first').checked ? '1' : '0'); } catch {}
    showDeviceFirst().catch(() => {}).then(showRoute);
  };
}

// How a note is read here: the cloud, this browser's model, or (demo, when
// turned on) this browser's model with the cloud as the fallback.
async function route() {
  if (PRIVATE && !$('cloud-opt-in').checked) {
    return {
      shape: 'v1', extractedBy: 'device',
      generate: (prompt, schema) => ai.generateStructured(prompt, schema, ai.InferenceMode.ONLY_ON_DEVICE),
    };
  }
  // The device prompt (v1) when the device is going to answer; if it fails
  // mid-way, the cloud model answers the same prompt, which it reads as well.
  if (!PRIVATE && $('device-first').checked && !ai.deviceStuck() && (await ai.deviceModelState()) === 'available') {
    return {
      shape: 'v1', extractedBy: (source) => readBy(source, ai.CLOUD_MODEL),
      generate: (prompt, schema) => ai.generatePreferDevice(prompt, schema),
    };
  }
  return {
    shape: 'v2', extractedBy: `cloud:${ai.CLOUD_MODEL}`,
    generate: (prompt, schema) => ai.generateStructured(prompt, schema, ai.InferenceMode.ONLY_IN_CLOUD),
    ...(!PRIVATE && $('device-first').checked ? { fallback: 'the device model is not ready' } : {}),
  };
}

$('read-note').onclick = async () => {
  const text = $('note').value.trim();
  const status = (cls, ...nodes) => $('capture-status').replaceChildren(el('span', { class: cls }, nodes));
  if (!text) {
    status('bad', 'The box is empty. Type or paste a note into it first; the grey example text is only a hint.');
    $('note').focus();
    return;
  }
  const when = $('note-when').value || localNow();
  $('read-note').disabled = true;
  status('muted', 'Reading the note…');
  let chosen = null;
  try {
    chosen = await route();
    const r = await pipeline.readNote(q, {
      text, kind: $('note-kind').value, occurredAt: new Date(when).toISOString(), baseDate: when.slice(0, 10),
      shape: chosen.shape, extractedBy: chosen.extractedBy, generate: chosen.generate,
    });
    const fallback = r.linking.fallback ?? chosen.fallback;
    $('cloud-opt-in').checked = false;
    $('cloud-preview').hidden = true;
    showRoute();
    for (const item of r.pending) pendingItems.push({ session: r.out.session, noteText: text, item });
    $('note').value = '';
    // The next note is from now, not from when the page was opened.
    $('note-when').value = localNow();
    await refresh();
    const { out, deps } = r;
    const dependencyLine = !deps ? ''
      : deps.error ? `Dependencies were not read: ${deps.error}`
        : `${deps.proposed + deps.waiting ? `Dependencies: ${deps.proposed} proposed, ${deps.waiting} waiting for you` : 'No dependency found'} (${deps.ms} ms).${deps.problems.filter((p) => !p.repaired).length ? ` ${deps.problems.filter((p) => !p.repaired).length} refused.` : ''}`;
    status(out.usable ? 'ok' : 'bad', [
      `Read by ${{ in_cloud: 'the cloud model', on_device: 'the model on this device' }[r.linking.source] ?? r.linking.source} in ${r.linking.ms} ms${fallback ? `, because ${fallback}` : ''}.`,
      r.linking.source === 'on_device' ? 'What it read is provisional: check each proposal, and the other commitments it could be about.' : '',
      out.usable ? '' : 'Its answer could not be used.',
      r.proposed || pendingItems.length
        ? `${count(r.proposed, 'proposal')} to review, ${count(pendingItems.length, 'thing')} that ${pendingItems.length === 1 ? 'needs' : 'need'} you first.`
        : 'It found nothing that promises or changes anything. The note is stored.',
      dependencyLine,
      out.recorded.invalid.length ? `${count(out.recorded.invalid.length, 'proposal')} ${out.recorded.invalid.length === 1 ? 'was' : 'were'} refused by the store rules.` : '',
      r.leftOut ? `${count(r.leftOut, 'open commitment')} ${r.leftOut === 1 ? 'was' : 'were'} not offered to the model: only the ${r.offered} closest to the note are.` : '',
      r.similarBefore ? 'The same text was captured before; this is stored as a new note.' : '',
    ].filter(Boolean).join(' '));
  } catch (err) {
    // The free tier allows 500 cloud requests a day; say so plainly, with when it comes back.
    const quota = /\b429\b|quota/i.test(err.message);
    const retry = /retry in ((\d+)h)?((\d+)m)?/i.exec(err.message);
    const message = quota
      ? `The cloud model's free quota is used up${retry ? `; it should work again in about ${retry[2] ? `${retry[2]} h ` : ''}${retry[4] ?? 0} min` : ''}.${PRIVATE ? ' The model on this device is not affected.' : ''}`
      : /storage locked/i.test(err.message) ? LOCKED_MESSAGE : err.message;
    status('bad', `Not read, and nothing was stored: ${message}`,
      ai.debugToken && chosen?.shape !== 'v1' && /app.?check|\b40[13]\b/i.test(err.message) ? ` On localhost the cloud model needs this browser's App Check debug token registered in the Firebase console: ${ai.debugToken}` : '');
  } finally {
    $('read-note').disabled = false;
  }
};

$('add-person').onclick = async () => {
  try {
    const result = await capture.addPerson(q, $('person-name').value);
    $('person-status').textContent = { added: 'Added.', exists: 'Already in the list.', empty: 'Type a name first.' }[result.outcome];
    if (result.outcome === 'added') $('person-name').value = '';
    await refresh();
  } catch (err) {
    $('person-status').textContent = `Error: ${err.message}`;
  }
};

const LOCKED_MESSAGE = `The ${PRIVATE ? 'private' : 'demo'} workspace is open in another tab, and only one tab can use it at a time. Use that tab, or close it and reload this one.`;

// The demo's Friday, which moves with the date the demo is loaded on.
// The demo asks about the scenario's Friday; your own workspace about the
// coming Friday (today, if it is a Friday), in local time.
function comingFriday(now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((5 - now.getDay() + 7) % 7));
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}
$('before').value = PRIVATE ? comingFriday() : data.demoDates().friday;

db.init(async (msg) => {
  if (msg.type === 'open-failed') {
    const locked = /locked/i.test(msg.error);
    $('status').replaceChildren(el('span', { class: 'bad' }, locked
      ? LOCKED_MESSAGE
      : `The store did not open: ${msg.error}`));
    // Nothing can be read or added without the store.
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    return;
  }
  try {
    // Cards left from an earlier visit, once per page: a restarted worker opens the store again.
    if (!loadedPending) {
      loadedPending = true;
      pendingItems.push(...await capture.loadPending(q));
    }
    await refresh();
  } catch (err) {
    $('status').replaceChildren(el('span', { class: 'bad' }, `Error: ${err.message}`));
  }
}, STORE);
