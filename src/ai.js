// Firebase AI Logic hybrid inference: extract commitments from a note.
// Runs in the page, never in the worker: Chrome's Prompt API is not available there.

import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import { initializeAppCheck, CustomProvider, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { firebaseConfig, recaptchaSiteKey } from './firebase-config.js';
import { makeDeviceGuard, STUCK_MESSAGE } from './device-guard.js';
import { hybridCall } from './hybrid.js';

export { InferenceMode };

export const CLOUD_MODEL = 'gemini-3.5-flash-lite';

// One JSON Schema for both sides, so on-device and cloud answers have the same shape.
export const extractionSchema = {
  type: 'object',
  properties: {
    commitments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string', description: 'The thing promised, as a short imperative phrase, e.g. "Send the proposal"' },
          owner: { type: 'string', description: 'Name of the person who has to do it; "me" for the note writer' },
          to: { type: 'string', description: 'Name of the person it is owed to, or "" if not stated' },
          due: { type: 'string', description: 'Due date or day exactly as written, e.g. "Friday", or "" if not stated' },
          waitingOn: { type: 'string', description: 'Only the name of the person whose action it depends on, e.g. "Lee". Never an action. "" if nobody' },
          blockedBy: { type: 'string', description: 'The action that must happen first, as a short imperative phrase without the person, e.g. "Confirm pricing". "" if nothing' },
        },
        required: ['what', 'owner', 'to', 'due', 'waitingOn', 'blockedBy'],
      },
    },
  },
  required: ['commitments'],
};

const instructions = `Extract every commitment from the note below.
A commitment is something a person has said they will do for someone.
Use only what the note says. Do not invent names or dates.

When a commitment depends on someone else acting first, split that into two fields:
"waitingOn" is that person's name only, and "blockedBy" is what they have to do.

"owner" is the person who will do the thing, and "to" is the person who receives it.
If someone else promises something to the note writer, that person is the owner and "to" is "me".
If the note contains no commitment, answer {"commitments":[]}.

Example note: "I'll ship the report to Sam on Monday after Priya signs off the numbers."
Example answer: {"commitments":[{"what":"Ship the report","owner":"me","to":"Sam","due":"Monday","waitingOn":"Priya","blockedBy":"Sign off the numbers"}]}

Example note: "Omar will email me the invoice by Thursday."
Example answer: {"commitments":[{"what":"Email the invoice","owner":"Omar","to":"me","due":"Thursday","waitingOn":"","blockedBy":""}]}

Example note: "Long day. The demo went well."
Example answer: {"commitments":[]}

Note:
`;

const app = initializeApp(firebaseConfig);

// App Check. The hosted site attests with reCAPTCHA Enterprise. On localhost
// the SDK exchanges a debug token instead, which must be registered once in
// the Firebase console (App Check > Apps > Manage debug tokens). That token is
// generated per browser and kept in localStorage, never in the repository.
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
export let debugToken = null;
if (isLocal) {
  debugToken = localStorage.getItem('kept.appCheckDebugToken');
  if (!debugToken) {
    debugToken = crypto.randomUUID();
    localStorage.setItem('kept.appCheckDebugToken', debugToken);
  }
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
  initializeAppCheck(app, {
    provider: new CustomProvider({
      getToken: () => Promise.reject(new Error('No attestation provider on localhost; debug token only.')),
    }),
    isTokenAutoRefreshEnabled: true,
  });
} else {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}

const ai = getAI(app, { backend: new GoogleAIBackend() });

// The SDK opens a Chrome session for each device call and closes it only when
// the same model object is used again, which never happens here: every call
// builds its own (the schema differs per call). Left open, sessions pile up,
// three a note, and Chrome's model failed with kErrorUnknown at about 85 of
// them (measured 2026-11-19). Stopping the signal a session was created with
// does not close it in Chrome (also measured). So the SDK is given this
// stand-in for LanguageModel: it creates the same sessions and remembers them,
// and each call closes its own when it ends (closeSessions).
const opened = new Set();
const deviceApi = {
  availability: (options) => LanguageModel.availability(options),
  create: async (options) => {
    const session = await LanguageModel.create(options);
    opened.add(session);
    return session;
  },
};
const sdkAdapter = ai.chromeAdapterFactory;
if (typeof sdkAdapter === 'function') {
  ai.chromeAdapterFactory = (mode, scope, params) => sdkAdapter(mode, 'LanguageModel' in self ? { LanguageModel: deviceApi } : scope, params);
} else {
  console.warn('Kept: this Firebase AI SDK builds its Chrome adapter differently; device sessions are not closed after a read.');
}
function closeSessions() {
  for (const session of opened) {
    try { session.destroy(); } catch { /* already closed */ }
  }
  opened.clear();
}

const deviceOptions = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

function modelFor(mode, schema = extractionSchema, signal) {
  return getGenerativeModel(ai, {
    mode,
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      },
    },
    onDeviceParams: {
      createOptions: signal ? { ...deviceOptions, signal } : deviceOptions,
      promptOptions: signal ? { responseConstraint: schema, signal } : { responseConstraint: schema },
    },
  });
}

// Must be called from a user gesture: it may start the model download.
export function prepareDeviceModel(onProgress) {
  return modelFor(InferenceMode.PREFER_ON_DEVICE).initializeDeviceModel(onProgress);
}

export async function deviceModelState() {
  if (!('LanguageModel' in self)) return 'unavailable';
  return LanguageModel.availability(deviceOptions);
}

// One short prompt through the raw Prompt API, in a session that is always
// closed afterwards. Every direct use of LanguageModel goes through here.
async function promptOnce(prompt, signal) {
  const session = await LanguageModel.create({ ...deviceOptions, signal });
  try { return await session.prompt(prompt, { signal }); } finally { session.destroy(); }
}

const guard = makeDeviceGuard({
  probe: async (signal) => {
    await whenVisible();
    await promptOnce('Say OK.', signal);
  },
});

// One idle session, kept while the page is open. Each read closes its own
// session when it ends (see generateStructured); with no session left open
// Chrome may unload the model and take about 20 s to load it for the next note.
let warm = null;
function keepWarm() {
  warm ??= LanguageModel.create(deviceOptions).catch(() => { warm = null; });
}

function whenVisible() {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return Promise.resolve();
  return new Promise((resolve) => {
    const shown = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', shown);
      resolve();
    };
    document.addEventListener('visibilitychange', shown);
  });
}

// True when the device model answers a short prompt within `ms`. Chrome's
// model sometimes stops answering until Chrome is restarted, most often when
// a session starts; the private workspace checks once when it opens, so the
// user learns it before writing a note, not after a 45 s wait. It is given
// 45 s: loading the model after a Chrome restart alone takes about 20 s.
export async function deviceResponds(ms = 45000) {
  try {
    await askDevice('Say OK.', ms);
    keepWarm();
    return true;
  } catch {
    return false;
  }
}

// Asks the device model one short question: waits for the tab to be shown,
// stops after `ms`, and closes its session. Throws if there is no answer.
export async function askDevice(prompt, ms = 45000) {
  await whenVisible();
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    const answer = await promptOnce(prompt, stop.signal);
    guard.answered();
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

export function extract(note, mode) {
  return generateStructured(instructions + note, extractionSchema, mode);
}

// One schema-constrained call through Firebase AI Logic, in the given mode.
// `checkLater`: after a device timeout, do not wait for the check of the model
// (up to 30 s) before failing. For a caller that goes to the cloud next.
export async function generateStructured(prompt, schema, mode, { checkLater = false } = {}) {
  // Only-on-device must fail at once when the model is not ready. Left to the
  // SDK, a click would start the model download and the call would wait for it.
  if (mode === InferenceMode.ONLY_ON_DEVICE) {
    const state = await deviceModelState();
    if (state !== 'available') {
      throw new Error(`The device model is not ready (${state}). Nothing was sent anywhere.`);
    }
  }
  // Chrome does not start the device model in a hidden tab: the call would
  // wait with no error. It starts when the tab is shown. A call that still does
  // not answer is stopped, not only given up on: the model answers one call at
  // a time, and an answer that never ends would hold up every later one.
  // Prefer-on-device is guarded the same way: it runs on the device whenever
  // the model is there (generatePreferDevice only calls it then).
  const onDevice = mode === InferenceMode.ONLY_ON_DEVICE || mode === InferenceMode.PREFER_ON_DEVICE;
  if (onDevice) {
    // Stuck earlier: this read still fails at once, and one more check starts
    // in the background, so a later read can use the model if it came back.
    if (guard.stuck) guard.retry();
    guard.check();
    await whenVisible();
  }
  const started = performance.now();
  let result;
  if (onDevice) {
    const limit = guard.limitMs;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), limit);
    try {
      result = await modelFor(mode, schema, stop.signal).generateContent(prompt);
      guard.answered();
    } catch (err) {
      if (!stop.signal.aborted) throw err;
      // Close the stopped call's session before checking: it may be what the
      // model is still busy with.
      closeSessions();
      const answers = guard.afterTimeout();
      if (!checkLater && !(await answers)) throw new Error(STUCK_MESSAGE);
      throw new Error(`The device model did not answer within ${limit / 1000} s, so it was stopped. Keep this tab in front while a note is read, then try again. Nothing was sent anywhere.`);
    } finally {
      clearTimeout(timer);
      // Close the session this call opened (see deviceApi), and keep one idle
      // session so Chrome does not unload the model between notes.
      if (result) keepWarm();
      closeSessions();
    }
  } else {
    result = await modelFor(mode, schema).generateContent(prompt);
  }
  const text = result.response.text();
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    parseError = err.message;
  }
  return {
    source: result.response.inferenceSource ?? 'not reported',
    ms: Math.round(performance.now() - started),
    parsed,
    parseError,
    raw: text,
  };
}

export const deviceStuck = () => guard.stuck;

// Hybrid inference for the demo workspace, when the user turns it on: Firebase
// AI Logic in PREFER_ON_DEVICE when Chrome's model is ready, the cloud model
// when it is not, or when the device call fails or takes too long (45 s for
// the first call on a page, 20 s once the model has answered). The answer
// says which model answered (`source`) and, if the cloud stood in, why
// (`fallback`). Only for demo data: a private note must never fall back.
export async function generatePreferDevice(prompt, schema) {
  // Stuck earlier: this note goes to the cloud, and the model is checked again
  // in the background, so a later note can be read on the device.
  if (guard.stuck) guard.retry();
  return hybridCall({
    deviceState: await deviceModelState(),
    stuck: guard.stuck,
    // After a timeout the cloud reads the note at once; whether the model is
    // stuck is found out in the background.
    callDevice: () => generateStructured(prompt, schema, InferenceMode.PREFER_ON_DEVICE, { checkLater: true }),
    callCloud: () => generateStructured(prompt, schema, InferenceMode.ONLY_IN_CLOUD),
  });
}
