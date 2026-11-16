// The review screen. It reads and writes the demo workspace's store through
// the rules in model.js; what it shows comes from review-data.js.
// A captured note is read by the cloud model (the demo workspace's route, see
// docs/linking-experiment.md) and goes through capture.js; the demo scenario is
// loaded as already-read notes.

import * as db from './db.js';
import * as m from './model.js';
import * as data from './review-data.js';
import * as capture from './capture.js';
import * as ai from './ai.js';
import { variants } from './linking-cases.js';

const STORE = 'opfs://kept-demo';
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
    rows.map((row) => el('tr', {}, columns.map(([, cell]) => el('td', {}, cell(row) ?? '')))));
}

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'date unknown');
const dueOf = (due, dueText) => (due && dueText ? `${dueText} (${due})` : due || dueText || '');

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
        el('div', { class: 'source muted' }, `From a ${item.note.kind}, ${when(item.note.occurredAt)}. Read from the note, not confirmed by you.`)]
      : el('div', { class: 'source muted' }, 'No source note.'),
    el('div', { class: 'actions' },
      el('button', { onclick: () => act(item.changeId, () => m.accept(q, item.changeId)) }, 'Accept'),
      el('button', { onclick: () => act(item.changeId, () => m.reject(q, item.changeId)) }, 'Reject'),
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
    ['Waiting for review', (c) => (c.pendingChanges ? `${c.pendingChanges} change(s)` : '')],
    ['', (c) => el('button', { onclick: () => why(c) }, 'Why?')],
  ], list, 'No commitments yet. Load the demo scenario.'));

  const select = $('person');
  const chosen = select.value;
  select.replaceChildren(...persons.filter((p) => !p.isMe).map((p) => el('option', { value: p.id }, p.name)));
  if (chosen) select.value = chosen;
  $('status').replaceChildren(el('span', { class: 'ok' }, `Store ${STORE} open: ${list.length} commitment(s), ${items.length} waiting for review.`));
}

const pending = (n) => (n ? `${n} change(s) waiting for review` : '');
const answer = (id, ...nodes) => $(id).replaceChildren(...nodes);
const needMe = (id) => {
  if (!me) answer(id, el('p', { class: 'muted' }, 'Load the demo scenario first.'));
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

$('ask-changed').onclick = guard('answer-changed', async () => {
  const personId = $('person').value;
  if (!personId) {
    answer('answer-changed', el('p', { class: 'muted' }, 'Load the demo scenario first.'));
    return;
  }
  const baseline = await m.meetingBaseline(q, { personId, previous: $('previous').checked });
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
    answer('answer-why',
      el('p', {}, el('strong', {}, `"${commitment.what}" is ${current.owner === 'Me' ? 'yours' : `${current.owner}'s`}. `), basis),
      proposals.map((p) => el('p', { class: 'muted' }, `Waiting for review: a note says ${p.proposedOwner} should own it ("${p.quote ?? ''}").`)));
    $('answer-why').scrollIntoView({ block: 'nearest' });
  } catch (err) {
    answer('answer-why', el('p', { class: 'bad' }, `Error: ${err.message}`));
  }
}

$('seed').onclick = async () => {
  try {
    const added = await data.seedDemo(q);
    await refresh();
    if (!added) $('status').append(' The store already has data; the demo scenario was not loaded again.');
  } catch (err) {
    $('status').replaceChildren(el('span', { class: 'bad' }, `Error: ${err.message}`));
  }
};

$('reset').onclick = async () => {
  try {
    await db.reset();
    messages.clear();
    decided.length = 0;
    pendingItems.length = 0;
    $('capture-status').replaceChildren();
    summaries.clear();
    for (const id of ['answer-owe', 'answer-waiting', 'answer-changed', 'answer-why']) answer(id);
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
  try {
    const result = work ? await work() : null;
    const refused = result?.invalid?.[0];
    if (refused) entry.error = `Not proposed: ${refused.reason}.`;
    else {
      pendingItems.splice(pendingItems.indexOf(entry), 1);
      // The capture line counted this as waiting; it no longer is.
      if (!pendingItems.length) $('capture-status').replaceChildren();
    }
  } catch (err) {
    entry.error = err.message;
  }
  await refresh();
}

function pendingCard(entry) {
  const { session, noteText, item } = entry;
  const source = el('blockquote', {}, quoted(noteText, item.quote));
  const error = entry.error && el('div', { class: 'message bad' }, entry.error);
  const dismiss = (label) => el('button', { onclick: () => settle(entry) }, label);
  const openOnes = commitmentRows.filter((c) => c.status === 'open');
  const become = (next) => () => {
    entry.item = next;
    entry.error = null;
    renderPending();
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
        el('button', { onclick: () => settle(entry, () => capture.proposeNew(q, session,
          { what: what.value, ownerId: owner.value, toId: to.value, dueText: due.value.trim(), quote: item.quote })) }, 'Propose it'),
        dismiss('Not a commitment')),
      error);
  }

  if (item.type === 'question') {
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
      return el('button', { onclick: become({ ...o, type: 'new' }) }, o.incomplete ? 'Something new' : `New: "${o.what}"`);
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
      openOnes.length > 0 && el('button', { onclick: () => settle(entry, () => {
        if (change.value === 'new deadline' && !due.value.trim()) throw new Error('A new deadline needs a date.');
        return capture.proposeChange(q, session, [{ commitmentId: target.value, change: change.value, due: due.value.trim(), quote: item.quote }]);
      }) }, 'Propose it'),
      item.saidNew
        ? el('button', { onclick: become(item.saidNew) }, `It is new: "${item.saidNew.what}"`)
        : el('button', { onclick: become({ type: 'new', what: '', quote: item.quote, dueText: '', ...capture.guessPeople(item.quote, personRows) }) }, 'It is something new'),
      dismiss('Nothing to do')),
    error);
}

function renderPending() {
  $('pending').replaceChildren(...(pendingItems.length
    ? [el('p', { class: 'muted' }, `${pendingItems.length} thing(s) from captured notes need you before they can be proposed. They are not saved: reloading the page drops them.`),
      ...pendingItems.map(pendingCard)]
    : []));
}

const localNow = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$('note-when').value = localNow();
$('cloud-model').textContent = ai.CLOUD_MODEL;

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
  try {
    const ready = await capture.prepare(q, text);
    const before = await m.findSimilarNotes(q, text);
    // Nothing is stored until the model has answered: a failed call leaves the note in the box.
    const variant = variants.v2;
    const result = await ai.generateStructured(variant.buildPrompt(text, ready.candidates), variant.buildSchema(ready.candidates), ai.InferenceMode.ONLY_IN_CLOUD);
    const out = await capture.capture(q, {
      text, kind: $('note-kind').value, occurredAt: new Date(when).toISOString(), baseDate: when.slice(0, 10),
      answer: result.parsed, shape: 'v2', candidates: ready.candidates, people: ready.people, extractedBy: `cloud:${ai.CLOUD_MODEL}`,
    });
    for (const item of out.pending) pendingItems.push({ session: out.session, noteText: text, item });
    $('note').value = '';
    // The next note is from now, not from when the page was opened.
    $('note-when').value = localNow();
    await refresh();
    const proposed = out.recorded.added.length;
    status(out.usable ? 'ok' : 'bad', [
      `Read by ${result.source === 'in_cloud' ? 'the cloud model' : result.source} in ${result.ms} ms.`,
      out.usable ? '' : 'Its answer could not be used.',
      proposed || out.pending.length
        ? `${proposed} proposal(s) to review, ${out.pending.length} thing(s) that need you first.`
        : 'It found nothing that promises or changes anything. The note is stored.',
      out.recorded.invalid.length ? `${out.recorded.invalid.length} proposal(s) were refused by the store rules.` : '',
      ready.leftOut ? `${ready.leftOut} open commitment(s) were not offered to the model: only the ${ready.candidates.length} closest to the note are.` : '',
      before.length ? 'The same text was captured before; this is stored as a new note.' : '',
    ].filter(Boolean).join(' '));
  } catch (err) {
    status('bad', `Not read, and nothing was stored: ${err.message}`,
      ai.debugToken ? ` On localhost the cloud model needs this browser's App Check debug token registered in the Firebase console: ${ai.debugToken}` : '');
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

// The demo's Friday, which moves with the date the demo is loaded on.
$('before').value = data.demoDates().friday;

db.init(async (msg) => {
  if (msg.type === 'open-failed') {
    const locked = /locked/i.test(msg.error);
    $('status').replaceChildren(el('span', { class: 'bad' }, locked
      ? 'This store is open in another tab. Close that tab and reload this one.'
      : `The store did not open: ${msg.error}`));
    return;
  }
  try {
    await refresh();
  } catch (err) {
    $('status').replaceChildren(el('span', { class: 'bad' }, `Error: ${err.message}`));
  }
}, STORE);
