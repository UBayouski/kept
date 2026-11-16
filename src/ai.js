// Firebase AI Logic hybrid inference: extract commitments from a note.
// Runs in the page, never in the worker: Chrome's Prompt API is not available there.

import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import { initializeAppCheck, CustomProvider, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { firebaseConfig, recaptchaSiteKey } from './firebase-config.js';

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

const deviceOptions = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

function modelFor(mode, schema = extractionSchema) {
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
      createOptions: deviceOptions,
      promptOptions: { responseConstraint: schema },
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

const DEVICE_TIMEOUT_MS = 90000;

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

export function extract(note, mode) {
  return generateStructured(instructions + note, extractionSchema, mode);
}

// One schema-constrained call through Firebase AI Logic, in the given mode.
export async function generateStructured(prompt, schema, mode) {
  // Only-on-device must fail at once when the model is not ready. Left to the
  // SDK, a click would start the model download and the call would wait for it.
  if (mode === InferenceMode.ONLY_ON_DEVICE) {
    const state = await deviceModelState();
    if (state !== 'available') {
      throw new Error(`The device model is not ready (${state}). Nothing was sent anywhere.`);
    }
  }
  // Chrome does not start the device model in a hidden tab: the call would
  // wait with no error. It starts when the tab is shown, and a call that still
  // does not answer is reported instead of left hanging.
  if (mode === InferenceMode.ONLY_ON_DEVICE) await whenVisible();
  const started = performance.now();
  const call = modelFor(mode, schema).generateContent(prompt);
  const result = mode === InferenceMode.ONLY_ON_DEVICE
    ? await Promise.race([call, new Promise((_, reject) => setTimeout(() => reject(new Error(
      `The device model did not answer within ${DEVICE_TIMEOUT_MS / 1000} s. Keep this tab in front while a note is read, then try again. Nothing was sent anywhere.`)), DEVICE_TIMEOUT_MS))])
    : await call;
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
