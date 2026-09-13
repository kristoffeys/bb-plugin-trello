import { describe, expect, test, vi } from 'vitest';
import { timingSafeEqual } from 'node:crypto';
import {
  AUTH_FAILURE_MESSAGES,
  CALLBACK_HEADERS,
  PENDING_AUTH_MAX,
  PENDING_AUTH_TTL_MS,
  callbackPageResponse,
  createCompleteAuthHandler,
  createNonceStore,
  isTrelloToken,
  resolveTrelloApiKey,
  timingSafeEqualStrings,
  trelloAuthCallbackUrl,
  trelloAuthorizeUrl,
  trelloCallbackOrigin,
  type NonceStore
} from '../trello/index.js';
import { TrelloApiError, authFault } from '../trello/client.js';

// Prove the constant-time primitive is really reached, rather than trusting a
// comment that says it is.
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

/** A well-formed Trello token: 64 hex characters. */
const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = `${'b'.repeat(63)}c`;
const API_KEY = 'k'.repeat(32);

function post(body: unknown): Request {
  return new Request('http://127.0.0.1:38886/api/v1/plugins/trello/http/auth/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

/**
 * A handler plus everything it did, so each test can assert on what was
 * persisted and what was logged as well as on the response.
 */
function harness(
  options: {
    apiKey?: string;
    nonces?: NonceStore;
    getViewer?: () => Promise<unknown>;
  } = {}
) {
  const saved: string[] = [];
  const logs: string[] = [];
  const nonces = options.nonces ?? createNonceStore();
  const handler = createCompleteAuthHandler({
    nonces,
    resolveApiKey: async () => options.apiKey ?? API_KEY,
    createApi: () => ({
      getViewer: options.getViewer ?? (async () => ({ id: 'member-1', name: 'Kristof' }))
    }),
    saveToken: async token => {
      saved.push(token);
    },
    log: message => logs.push(message)
  });
  return { handler, nonces, saved, logs };
}

// ---------------------------------------------------------------------------
// The state nonce — the only barrier against a local caller
// ---------------------------------------------------------------------------

describe('state nonce', () => {
  test('a freshly issued nonce is accepted exactly once', () => {
    const nonces = createNonceStore();
    const nonce = nonces.issue();
    expect(nonces.consume(nonce)).toBe(true);
    // Single use: a replayed callback finds nothing left to match.
    expect(nonces.consume(nonce)).toBe(false);
  });

  test('an unknown nonce is rejected', () => {
    const nonces = createNonceStore();
    nonces.issue();
    expect(nonces.consume('Zm9vYmFyYmF6'.repeat(3))).toBe(false);
  });

  test('an absent or non-string state is rejected', () => {
    const nonces = createNonceStore();
    nonces.issue();
    expect(nonces.consume(undefined)).toBe(false);
    expect(nonces.consume(null)).toBe(false);
    expect(nonces.consume('')).toBe(false);
    expect(nonces.consume({ toString: () => 'nope' })).toBe(false);
    expect(nonces.consume(['nope'])).toBe(false);
  });

  test('a nonce of the wrong length is rejected without throwing', () => {
    const nonces = createNonceStore();
    const nonce = nonces.issue();
    // timingSafeEqual throws on a length mismatch; the wrapper must not.
    expect(() => nonces.consume(nonce.slice(0, -1))).not.toThrow();
    expect(nonces.consume(nonce.slice(0, -1))).toBe(false);
    expect(nonces.consume(`${nonce}x`)).toBe(false);
    // The real one still works: a near miss must not have consumed it.
    expect(nonces.consume(nonce)).toBe(true);
  });

  test('a nonce past its TTL is rejected', () => {
    let clock = 1_000;
    const nonces = createNonceStore({ now: () => clock });
    const nonce = nonces.issue();
    clock += PENDING_AUTH_TTL_MS - 1;
    expect(nonces.size).toBe(1);
    clock += 2;
    expect(nonces.consume(nonce)).toBe(false);
    expect(nonces.size).toBe(0);
  });

  test('repeated Connect clicks cannot grow the pending set without limit', () => {
    const nonces = createNonceStore();
    const issued = Array.from({ length: PENDING_AUTH_MAX * 5 }, () => nonces.issue());
    expect(nonces.size).toBe(PENDING_AUTH_MAX);
    // The oldest are the ones dropped; the most recent still work.
    expect(nonces.consume(issued[0]!)).toBe(false);
    expect(nonces.consume(issued.at(-1)!)).toBe(true);
  });

  test('several outstanding attempts each stay independently valid', () => {
    const nonces = createNonceStore();
    const first = nonces.issue();
    const second = nonces.issue();
    expect(nonces.consume(second)).toBe(true);
    expect(nonces.consume(first)).toBe(true);
  });

  test('clear() drops every pending attempt (what disconnect relies on)', () => {
    const nonces = createNonceStore();
    const nonce = nonces.issue();
    nonces.clear();
    expect(nonces.size).toBe(0);
    expect(nonces.consume(nonce)).toBe(false);
  });

  test('comparison goes through crypto.timingSafeEqual', () => {
    vi.mocked(timingSafeEqual).mockClear();
    const nonces = createNonceStore();
    const nonce = nonces.issue();
    nonces.consume(nonce);
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalled();
  });

  test('timingSafeEqualStrings is correct on the cases that matter', () => {
    expect(timingSafeEqualStrings('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStrings('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStrings('abc', 'ab')).toBe(false);
    expect(timingSafeEqualStrings('', '')).toBe(true);
  });

  test('nonces are long, random and URL-safe', () => {
    const nonces = createNonceStore({ max: 1000 });
    const seen = new Set(Array.from({ length: 200 }, () => nonces.issue()));
    expect(seen.size).toBe(200);
    for (const nonce of seen) {
      // 32 bytes of base64url.
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    }
  });
});

// ---------------------------------------------------------------------------
// Token shape
// ---------------------------------------------------------------------------

describe('token shape', () => {
  test('accepts 64 hex characters', () => {
    expect(isTrelloToken(TOKEN)).toBe(true);
    expect(isTrelloToken('0123456789abcdef'.repeat(4))).toBe(true);
    expect(isTrelloToken('0123456789ABCDEF'.repeat(4))).toBe(true);
  });

  test('rejects everything else', () => {
    expect(isTrelloToken(`${'a'.repeat(63)}`)).toBe(false);
    expect(isTrelloToken(`${'a'.repeat(65)}`)).toBe(false);
    expect(isTrelloToken(`${'a'.repeat(63)}z`)).toBe(false);
    expect(isTrelloToken('')).toBe(false);
    expect(isTrelloToken(undefined)).toBe(false);
    expect(isTrelloToken(null)).toBe(false);
    expect(isTrelloToken(12345)).toBe(false);
    expect(isTrelloToken(`${'a'.repeat(64)}\n`)).toBe(false);
    // No sneaking a newline in to split a later log line.
    expect(isTrelloToken(`${'a'.repeat(32)}\n${'a'.repeat(31)}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The completion route
// ---------------------------------------------------------------------------

describe('POST auth/complete', () => {
  test('stores the token once state, shape and Trello all agree', async () => {
    const { handler, nonces, saved } = harness();
    const response = await handler(post({ state: nonces.issue(), token: TOKEN }));
    expect(response.status).toBe(200);
    expect(saved).toEqual([TOKEN]);
  });

  test('rejects an unknown state without touching the token', async () => {
    const { handler, saved, logs } = harness();
    const response = await handler(post({ state: 'not-a-real-nonce', token: TOKEN }));
    expect(response.status).toBe(403);
    expect(await response.clone().json()).toEqual({
      ok: false,
      error: AUTH_FAILURE_MESSAGES.state
    });
    expect(saved).toEqual([]);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  test('rejects a replayed callback', async () => {
    const { handler, nonces, saved } = harness();
    const state = nonces.issue();
    expect((await handler(post({ state, token: TOKEN }))).status).toBe(200);

    const replay = await handler(post({ state, token: OTHER_TOKEN }));
    expect(replay.status).toBe(403);
    // The replay must not have overwritten the stored credential.
    expect(saved).toEqual([TOKEN]);
  });

  test('rejects an expired state', async () => {
    let clock = 0;
    const nonces = createNonceStore({ now: () => clock });
    const { handler, saved } = harness({ nonces });
    const state = nonces.issue();
    clock += PENDING_AUTH_TTL_MS + 1;
    expect((await handler(post({ state, token: TOKEN }))).status).toBe(403);
    expect(saved).toEqual([]);
  });

  test('rejects a missing state', async () => {
    const { handler, nonces, saved } = harness();
    nonces.issue();
    expect((await handler(post({ token: TOKEN }))).status).toBe(403);
    expect(saved).toEqual([]);
  });

  test('a bad token shape is refused after a valid state, and nothing is stored', async () => {
    const { handler, nonces, saved } = harness();
    const response = await handler(post({ state: nonces.issue(), token: 'nope' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(AUTH_FAILURE_MESSAGES.tokenShape);
    expect(saved).toEqual([]);
  });

  test('the state is consumed even when the rest of the request is junk', async () => {
    // Otherwise a caller could probe token shapes against one nonce forever.
    const { handler, nonces } = harness();
    const state = nonces.issue();
    await handler(post({ state, token: 'nope' }));
    expect(nonces.consume(state)).toBe(false);
  });

  test('a malformed body is refused before anything else', async () => {
    const { handler, nonces, saved } = harness();
    nonces.issue();
    expect((await handler(post('{not json'))).status).toBe(400);
    expect((await handler(post('"a string"'))).status).toBe(400);
    expect((await handler(post('[1,2,3]'))).status).toBe(400);
    expect(saved).toEqual([]);
    expect(nonces.size).toBe(1);
  });

  test('an oversized body is refused', async () => {
    const { handler, nonces, saved } = harness();
    const response = await handler(
      post({ state: nonces.issue(), token: TOKEN, padding: 'x'.repeat(8192) })
    );
    expect(response.status).toBe(413);
    expect(saved).toEqual([]);
  });

  test('with no API key at all, nothing is stored and the message says so', async () => {
    const { handler, nonces, saved } = harness({ apiKey: '' });
    const response = await handler(post({ state: nonces.issue(), token: TOKEN }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe(AUTH_FAILURE_MESSAGES.noKey);
    expect(body.error).toContain('https://trello.com/power-ups/admin');
    expect(saved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Verify before storing
// ---------------------------------------------------------------------------

describe('verification against /1/members/me', () => {
  test('the candidate credential is what gets verified', async () => {
    const seen: unknown[] = [];
    const saved: string[] = [];
    const nonces = createNonceStore();
    const handler = createCompleteAuthHandler({
      nonces,
      resolveApiKey: async () => API_KEY,
      createApi: credentials => {
        seen.push(credentials);
        return { getViewer: async () => ({ id: 'member-1' }) };
      },
      saveToken: async token => {
        // Verification must already have happened by now.
        expect(seen).toHaveLength(1);
        saved.push(token);
      },
      log: () => undefined
    });
    await handler(post({ state: nonces.issue(), token: TOKEN }));
    expect(seen).toEqual([{ apiKey: API_KEY, apiToken: TOKEN }]);
    expect(saved).toEqual([TOKEN]);
  });

  test('a 401 from Trello means nothing is persisted', async () => {
    const { handler, nonces, saved } = harness({
      getViewer: async () => {
        throw new TrelloApiError('invalid token', 401);
      }
    });
    const response = await handler(post({ state: nonces.issue(), token: TOKEN }));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe(AUTH_FAILURE_MESSAGES.invalidToken);
    expect(saved).toEqual([]);
  });

  test('a 401 naming the key is reported as a key problem', async () => {
    const { handler, nonces, saved } = harness({
      getViewer: async () => {
        throw new TrelloApiError('invalid key', 401);
      }
    });
    const response = await handler(post({ state: nonces.issue(), token: TOKEN }));
    expect((await response.json()).error).toBe(AUTH_FAILURE_MESSAGES.invalidKey);
    expect(saved).toEqual([]);
  });

  test('an unreachable Trello means nothing is persisted', async () => {
    const { handler, nonces, saved } = harness({
      getViewer: async () => {
        throw new TrelloApiError('Could not reach Trello: socket hang up');
      }
    });
    const response = await handler(post({ state: nonces.issue(), token: TOKEN }));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe(AUTH_FAILURE_MESSAGES.unreachable);
    expect(saved).toEqual([]);
  });

  test('a token with no member behind it is not persisted', async () => {
    const { handler, nonces, saved } = harness({ getViewer: async () => null });
    const response = await handler(post({ state: nonces.issue(), token: TOKEN }));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe(AUTH_FAILURE_MESSAGES.noViewer);
    expect(saved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nothing leaks, on any path
// ---------------------------------------------------------------------------

describe('no credential reaches a response body or a log line', () => {
  const failures: { name: string; options: Parameters<typeof harness>[0]; body: unknown }[] = [
    { name: 'unknown state', options: {}, body: { state: 'wrong', token: TOKEN } },
    {
      name: 'bad token shape',
      options: {},
      body: { state: '', token: `${TOKEN}-extra` }
    },
    { name: 'no api key', options: { apiKey: '' }, body: { state: '', token: TOKEN } },
    {
      name: 'trello 401 (token)',
      options: {
        getViewer: async () => {
          throw new TrelloApiError(`invalid token ${TOKEN}`, 401);
        }
      },
      body: { state: '', token: TOKEN }
    },
    {
      name: 'trello 401 (key)',
      options: {
        getViewer: async () => {
          throw new TrelloApiError(`invalid key ${API_KEY}`, 401);
        }
      },
      body: { state: '', token: TOKEN }
    },
    {
      name: 'transport error echoing the request URL',
      options: {
        getViewer: async () => {
          throw new TrelloApiError(
            `Could not reach https://api.trello.com/1/members/me?key=${API_KEY}&token=${TOKEN}`
          );
        }
      },
      body: { state: '', token: TOKEN }
    },
    {
      name: 'no viewer',
      options: { getViewer: async () => null },
      body: { state: '', token: TOKEN }
    },
    { name: 'malformed body', options: {}, body: `{"token":"${TOKEN}"` }
  ];

  for (const failure of failures) {
    test(`${failure.name} leaks nothing`, async () => {
      const { handler, nonces, logs } = harness(failure.options);
      const state = nonces.issue();
      const body =
        typeof failure.body === 'string'
          ? failure.body
          : { ...(failure.body as object), state: (failure.body as { state: string }).state === '' ? state : (failure.body as { state: string }).state };
      const response = await handler(post(body));

      const text = await response.text();
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(API_KEY);
      const logged = logs.join('\n');
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(API_KEY);
      // Every failure still says something the user can act on.
      expect(logged.length).toBeGreaterThan(0);
    });
  }

  test('the success response carries no credential either', async () => {
    const { handler, nonces, logs } = harness();
    const response = await handler(post({ state: nonces.issue(), token: TOKEN }));
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(API_KEY);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  test('responses are not cacheable', async () => {
    const { handler, nonces } = harness();
    const ok = await handler(post({ state: nonces.issue(), token: TOKEN }));
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const bad = await handler(post({ state: 'wrong', token: TOKEN }));
    expect(bad.headers.get('cache-control')).toBe('no-store');
  });
});

// ---------------------------------------------------------------------------
// invalid key vs invalid token
// ---------------------------------------------------------------------------

describe('authFault distinguishes the two credentials', () => {
  // The two strings below are what the live API actually answers: a bogus key
  // gives 401 "invalid key", and a good key with no token gives "invalid token".
  test('names the key', () => {
    expect(authFault(new TrelloApiError('invalid key', 401))).toBe('key');
  });

  test('names the token', () => {
    expect(authFault(new TrelloApiError('invalid token', 401))).toBe('token');
    expect(authFault(new TrelloApiError('invalid app token', 401))).toBe('token');
    expect(
      authFault(new TrelloApiError('unauthorized permission requested', 401))
    ).toBe('token');
  });

  test('says nothing when Trello did not', () => {
    expect(authFault(new TrelloApiError('something else entirely', 401))).toBeNull();
  });

  test('a non-401 is never a credential fault', () => {
    // A 403 means the credential is fine but the board is not visible.
    expect(authFault(new TrelloApiError('invalid key', 403))).toBeNull();
    expect(authFault(new TrelloApiError('invalid token', 500))).toBeNull();
    expect(authFault(new Error('invalid key'))).toBeNull();
    expect(authFault(null)).toBeNull();
  });

  test('the two produce different user-facing messages', () => {
    expect(AUTH_FAILURE_MESSAGES.invalidKey).not.toBe(
      AUTH_FAILURE_MESSAGES.invalidToken
    );
    expect(AUTH_FAILURE_MESSAGES.invalidKey).toMatch(/API key/iu);
    expect(AUTH_FAILURE_MESSAGES.invalidToken).toMatch(/token/iu);
  });
});

// ---------------------------------------------------------------------------
// The bundled key and its fallback
// ---------------------------------------------------------------------------

describe('resolveTrelloApiKey', () => {
  test('a user-supplied key always wins over the bundled default', () => {
    expect(resolveTrelloApiKey('user-key', 'bundled-key')).toBe('user-key');
  });

  test('falls back to the bundled key when the user has none', () => {
    expect(resolveTrelloApiKey(null, 'bundled-key')).toBe('bundled-key');
    expect(resolveTrelloApiKey('', 'bundled-key')).toBe('bundled-key');
    expect(resolveTrelloApiKey('   ', 'bundled-key')).toBe('bundled-key');
  });

  test('an empty bundled key with no user key means no key at all', () => {
    // The shipped state while no Power-Up key is baked in: the UI has to ask
    // for one rather than sending an empty key to Trello.
    expect(resolveTrelloApiKey(null, '')).toBeNull();
    expect(resolveTrelloApiKey(null, '   ')).toBeNull();
    expect(resolveTrelloApiKey('', '')).toBeNull();
  });

  test('a user key still works when the bundled key is empty', () => {
    expect(resolveTrelloApiKey('user-key', '')).toBe('user-key');
  });

  test('surrounding whitespace never reaches a request URL', () => {
    expect(resolveTrelloApiKey('  user-key\n', '')).toBe('user-key');
    expect(resolveTrelloApiKey(null, '  bundled-key  ')).toBe('bundled-key');
  });
});

// ---------------------------------------------------------------------------
// The callback page
// ---------------------------------------------------------------------------

describe('GET auth/callback', () => {
  test('carries the intended security headers', () => {
    const response = callbackPageResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  test('the CSP lets nothing but the one inline script run', async () => {
    const csp = CALLBACK_HEADERS['content-security-policy']!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // A hash, not 'unsafe-inline': any edit to the script breaks the page
    // loudly rather than silently widening what may execute.
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+={0,2}'/u);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  test('the CSP hash actually matches the script that ships', async () => {
    const { createHash } = await vi.importActual<typeof import('node:crypto')>(
      'node:crypto'
    );
    const html = await callbackPageResponse().text();
    const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
    expect(script).toBeTypeOf('string');
    const digest = createHash('sha256').update(script!, 'utf8').digest('base64');
    expect(CALLBACK_HEADERS['content-security-policy']).toContain(
      `script-src 'sha256-${digest}'`
    );
  });

  test('the page is a fixed string with nothing templated into it', async () => {
    const first = await callbackPageResponse().text();
    const second = await callbackPageResponse().text();
    expect(first).toBe(second);
    // It posts to a RELATIVE path, so not even the plugin id is baked in.
    expect(first).toContain("fetch('./complete'");
    expect(first).toContain('history.replaceState');
  });
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe('authorize URL', () => {
  const url = new URL(
    trelloAuthorizeUrl({ apiKey: API_KEY, returnUrl: 'http://127.0.0.1:38886/cb?state=n' })
  );

  test('targets Trello with the documented parameters', () => {
    expect(url.origin + url.pathname).toBe('https://trello.com/1/authorize');
    expect(url.searchParams.get('expiration')).toBe('never');
    expect(url.searchParams.get('scope')).toBe('read,write');
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.get('callback_method')).toBe('fragment');
    expect(url.searchParams.get('key')).toBe(API_KEY);
    expect(url.searchParams.get('return_url')).toBe('http://127.0.0.1:38886/cb?state=n');
  });

  test('does not ask for the account scope', () => {
    // `account` exists to read member emails, which this plugin has no use for.
    expect(url.searchParams.get('scope')).not.toContain('account');
  });

  test('the callback URL carries the nonce, since /1/authorize has no state param', () => {
    const callback = new URL(
      trelloAuthCallbackUrl('http://127.0.0.1:38886', 'trello', 'nonce-value')
    );
    expect(callback.pathname).toBe('/api/v1/plugins/trello/http/auth/callback');
    expect(callback.searchParams.get('state')).toBe('nonce-value');
  });

  test('reports the origin Trello has to be allowed to redirect to', () => {
    expect(trelloCallbackOrigin('http://127.0.0.1:38886')).toBe('http://127.0.0.1:38886');
    expect(trelloCallbackOrigin('not a url')).toBe('');
  });
});
