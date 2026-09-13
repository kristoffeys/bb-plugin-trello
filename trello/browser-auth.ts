// One-click browser authorization for Trello.
//
// Trello has no OAuth 2.0 and no `state` parameter on /1/authorize, and it
// returns the minted token in the URL **fragment** — which a browser never
// sends to a server. So the shape of this flow is forced:
//
//   1. BB mints a single-use state nonce and opens
//      https://trello.com/1/authorize?…&callback_method=fragment
//      &return_url=<BB callback>?state=<nonce>
//   2. Trello redirects the browser to that callback with `#token=…`.
//   3. The callback serves a STATIC page whose inline script reads the token
//      out of `location.hash` and the nonce out of `location.search`, and
//      POSTs both back to BB.
//   4. BB checks the nonce, checks the token's shape, verifies it against
//      GET /1/members/me, and only then stores it.
//
// ---------------------------------------------------------------------------
// Threat model
// ---------------------------------------------------------------------------
// The GET callback is `auth: "none"` because it is reached by a plain browser
// navigation from trello.com, which cannot carry BB's own auth. That route is
// safe by construction: it answers one fixed byte string, reflects nothing
// from the request, reads nothing, and writes nothing.
//
// The POST is the route that can write a credential into this install, so it
// is `auth: "local"` — the strictest mode that still works, since the caller
// is our own same-origin callback page. That gives two independent barriers:
//
//   - BB's local-origin check plus the mandatory `application/json` content
//     type. A cross-origin page cannot forge this: an HTML form cannot send
//     application/json, and `fetch` with that content type forces a CORS
//     preflight that BB answers with 403 for a foreign origin.
//   - The state nonce: 32 random bytes, single-use, five-minute TTL, compared
//     in constant time. A caller that already sits on the local origin (any
//     process on this machine can talk to loopback) gets past the first
//     barrier, so **the nonce is the only thing between such a caller and
//     writing a credential into the user's plugin**. It is therefore checked
//     before anything else in the handler — before the token is looked at, a
//     key is read, or a request leaves the machine.
//
// Nothing here ever puts a token in a response body, an error message, or a
// log line: every failure answers with a fixed sentence chosen from a list in
// this file.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createTrelloApi } from './api';
import { authFault, type TrelloCredentials } from './client';
import { TRELLO_POWER_UP_ADMIN_URL } from './app-key';

// Why: bb.http.route rejects a path without a leading slash, so these carry
// one and the URL builder below concatenates against `/http` rather than
// `/http/`.
/** Route paths, relative to /api/v1/plugins/<id>/http. */
export const AUTH_CALLBACK_PATH = '/auth/callback';
export const AUTH_COMPLETE_PATH = '/auth/complete';

/** Long enough that a slow approval still lands, short enough to bound reuse. */
export const PENDING_AUTH_TTL_MS = 5 * 60_000;
/** Repeated "Connect" clicks must not grow memory without limit. */
export const PENDING_AUTH_MAX = 8;
/** 32 bytes, per the requirement that guessing be hopeless. */
export const NONCE_BYTES = 32;

/**
 * Trello tokens are 64 hex characters. Enforced on the browser callback
 * because that input is untrusted; the `--token-file` CLI path deliberately
 * does not enforce it, so a future format change still has a way in.
 */
const TRELLO_TOKEN_PATTERN = /^[0-9a-f]{64}$/iu;

/** The most a legitimate callback POST can be: a nonce and a 64-char token. */
const MAX_BODY_BYTES = 4096;

export function isTrelloToken(value: unknown): value is string {
  return typeof value === 'string' && TRELLO_TOKEN_PATTERN.test(value);
}

/**
 * Constant-time string comparison. Length is compared first — `timingSafeEqual`
 * throws on a length mismatch, and a nonce's length is not a secret.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface NonceStore {
  /** Mint a nonce for one authorization attempt. */
  issue(): string;
  /** True exactly once per nonce, and only while it is unexpired. */
  consume(candidate: unknown): boolean;
  /** Forget every pending attempt (disconnect). */
  clear(): void;
  /** Unexpired pending attempts; for tests and the bound. */
  readonly size: number;
}

export function createNonceStore(
  options: { ttlMs?: number; max?: number; now?: () => number } = {}
): NonceStore {
  const ttlMs = options.ttlMs ?? PENDING_AUTH_TTL_MS;
  const max = options.max ?? PENDING_AUTH_MAX;
  const now = options.now ?? Date.now;
  let pending: { nonce: string; expiresAt: number }[] = [];

  function prune(): void {
    const cutoff = now();
    pending = pending.filter(entry => entry.expiresAt > cutoff);
  }

  return {
    issue(): string {
      prune();
      // Bounded: the oldest pending attempt is dropped rather than letting a
      // click-happy user (or a loop) grow this without limit.
      while (pending.length >= max) pending.shift();
      const nonce = randomBytes(NONCE_BYTES).toString('base64url');
      pending.push({ nonce, expiresAt: now() + ttlMs });
      return nonce;
    },

    consume(candidate: unknown): boolean {
      prune();
      if (typeof candidate !== 'string') return false;
      // No early exit: every surviving entry is compared, so the work done
      // does not depend on which entry matched.
      let matched = -1;
      for (let index = 0; index < pending.length; index += 1) {
        if (timingSafeEqualStrings(pending[index]!.nonce, candidate)) {
          matched = index;
        }
      }
      if (matched === -1) return false;
      // Single use: a replayed callback finds nothing to match.
      pending.splice(matched, 1);
      return true;
    },

    clear(): void {
      pending = [];
    },

    get size(): number {
      prune();
      return pending.length;
    }
  };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Where Trello sends the browser back to. The nonce rides in the query because
 * /1/authorize has no `state` parameter of its own; Trello appends its
 * `#token=…` fragment after the query, so both survive.
 */
export function trelloAuthCallbackUrl(
  loopbackBaseUrl: string,
  pluginId: string,
  state: string
): string {
  const url = new URL(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${AUTH_CALLBACK_PATH}`,
    loopbackBaseUrl
  );
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * The origin the user has to add to their API key's **allowed origins** on
 * trello.com. Trello blocks the redirect otherwise: "If your API key has no
 * allowed origins set, then no redirect URL will work."
 */
export function trelloCallbackOrigin(loopbackBaseUrl: string): string {
  try {
    return new URL(loopbackBaseUrl).origin;
  } catch {
    return '';
  }
}

export function trelloAuthorizeUrl(args: {
  apiKey: string;
  returnUrl: string;
}): string {
  const params = new URLSearchParams({
    // `never`: BB is a long-lived local install, and a token that silently
    // expires turns into a support question rather than a security win — the
    // user can revoke it any time from trello.com/u/<name>/account.
    expiration: 'never',
    // No `account`: that scope exists to read member emails, which this
    // plugin has no use for.
    scope: 'read,write',
    response_type: 'token',
    // `fragment` (not `postMessage`): BB opens the prompt as a top-level
    // navigation in the user's browser, not in an iframe with an opener.
    callback_method: 'fragment',
    // Undocumented in the current REST guide but long honoured: the label
    // Trello shows on the approval prompt. Harmless if ignored.
    name: 'BB',
    key: args.apiKey,
    return_url: args.returnUrl
  });
  return `https://trello.com/1/authorize?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// The callback page
// ---------------------------------------------------------------------------

// A static string. Everything request-controlled (the token in the fragment,
// the nonce in the query) is read by this script from the browser's own URL,
// so nothing is ever templated into the markup.
//
// `./complete` resolves against /…/http/auth/callback to /…/http/auth/complete,
// which also keeps the plugin id out of the page.
const CALLBACK_SCRIPT = `(function () {
  var status = document.getElementById('bb-status');
  function say(text) { status.textContent = text; }
  var fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  var token = fragment.get('token') || '';
  var denied = fragment.get('error') || '';
  var state = new URLSearchParams(location.search).get('state') || '';
  // Keep the token out of the address bar, history and any later copy/paste.
  history.replaceState(null, '', location.pathname);
  if (denied || !token) {
    say('Trello did not grant access. Close this tab and try Connect again in BB.');
    return;
  }
  fetch('./complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: state, token: token })
  }).then(function (response) {
    return response.json().catch(function () { return {}; }).then(function (body) {
      say(response.ok
        ? 'Trello is connected. You can close this tab.'
        : (body && typeof body.error === 'string' ? body.error : 'Could not finish connecting to Trello.'));
    });
  }).catch(function () {
    say('Could not reach BB to finish connecting. Close this tab and try Connect again.');
  });
})();`;

const CALLBACK_SCRIPT_HASH = createHash('sha256')
  .update(CALLBACK_SCRIPT, 'utf8')
  .digest('base64');

/**
 * Tight enough that the one inline script above is the only thing that can
 * run: no other script source, no styles, no images, no frames, and the only
 * network the page may make is back to this origin.
 */
const CALLBACK_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${CALLBACK_SCRIPT_HASH}'`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

export const CALLBACK_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  // The URL that reaches this page carries a token in its fragment; none of
  // it may be kept anywhere.
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': CALLBACK_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
});

const CALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connecting Trello to BB</title>
</head>
<body>
<h1>Connecting Trello to BB</h1>
<p id="bb-status">Finishing the connection…</p>
<script>${CALLBACK_SCRIPT}</script>
</body>
</html>
`;

/** The whole GET handler: one fixed page, no request input of any kind. */
export function callbackPageResponse(): Response {
  return new Response(CALLBACK_HTML, {
    status: 200,
    headers: { ...CALLBACK_HEADERS }
  });
}

// ---------------------------------------------------------------------------
// The completion POST
// ---------------------------------------------------------------------------

/**
 * Every sentence this route can answer with. Fixed strings: no request value,
 * no upstream text and above all no token can reach a response body, and the
 * same strings are what gets logged.
 */
export const AUTH_FAILURE_MESSAGES = {
  malformed: 'That request was not a valid Trello callback.',
  state:
    'This Trello authorization link is no longer valid. Start again from the Connect button in BB.',
  tokenShape:
    'Trello returned a token in an unexpected format. Nothing was saved.',
  noKey: `No Trello API key is configured. Add one from ${TRELLO_POWER_UP_ADMIN_URL} and paste it into the Trello connection form in BB.`,
  invalidKey:
    'Trello rejected the API key. Check the key, and that BB’s address is listed in that key’s allowed origins.',
  invalidToken:
    'Trello rejected the new token. Nothing was saved — try connecting again.',
  noViewer:
    'Trello did not return a member for this token. Nothing was saved.',
  unreachable: 'Could not reach Trello to verify the new token. Nothing was saved.'
} as const;

export interface CompleteAuthDeps {
  nonces: NonceStore;
  /** The key in force: the user's own, else the bundled one. '' when neither. */
  resolveApiKey: () => Promise<string>;
  /** Injectable so tests can verify without a network. */
  createApi?: (
    credentials: TrelloCredentials
  ) => { getViewer: () => Promise<unknown> };
  /** Called only after Trello has confirmed the credential works. */
  saveToken: (token: string) => Promise<void>;
  /** Receives the same fixed sentence the caller is given — never a token. */
  log: (message: string) => void;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function failure(status: number, message: string, log: (m: string) => void): Response {
  log(`Trello browser authorization refused: ${message}`);
  return jsonResponse(status, { ok: false, error: message });
}

/**
 * Handles POST auth/complete. Takes a plain `Request` rather than a Hono
 * context so it can be exercised directly from a test.
 */
export function createCompleteAuthHandler(
  deps: CompleteAuthDeps
): (request: Request) => Promise<Response> {
  const createApi = deps.createApi ?? (credentials => createTrelloApi(credentials));

  return async function handleComplete(request: Request): Promise<Response> {
    let payload: Record<string, unknown>;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) {
        return failure(413, AUTH_FAILURE_MESSAGES.malformed, deps.log);
      }
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return failure(400, AUTH_FAILURE_MESSAGES.malformed, deps.log);
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return failure(400, AUTH_FAILURE_MESSAGES.malformed, deps.log);
    }

    // FIRST, before the token is so much as looked at. Any caller that can
    // reach loopback can reach this route; the nonce is what separates our own
    // callback page from everything else on the machine.
    if (!deps.nonces.consume(payload.state)) {
      return failure(403, AUTH_FAILURE_MESSAGES.state, deps.log);
    }

    const token = payload.token;
    if (!isTrelloToken(token)) {
      return failure(400, AUTH_FAILURE_MESSAGES.tokenShape, deps.log);
    }

    const apiKey = await deps.resolveApiKey();
    if (apiKey === '') {
      return failure(409, AUTH_FAILURE_MESSAGES.noKey, deps.log);
    }

    // Verify before storing: a token that cannot read /1/members/me is not
    // worth persisting, and finding out now is how the user gets a useful
    // error instead of a board that silently never loads.
    try {
      const viewer = await createApi({ apiKey, apiToken: token }).getViewer();
      if (viewer === null) {
        return failure(502, AUTH_FAILURE_MESSAGES.noViewer, deps.log);
      }
    } catch (error) {
      const fault = authFault(error);
      const message =
        fault === 'key'
          ? AUTH_FAILURE_MESSAGES.invalidKey
          : fault === 'token'
            ? AUTH_FAILURE_MESSAGES.invalidToken
            : AUTH_FAILURE_MESSAGES.unreachable;
      return failure(502, message, deps.log);
    }

    await deps.saveToken(token);
    deps.log('Trello browser authorization completed.');
    return jsonResponse(200, { ok: true });
  };
}
