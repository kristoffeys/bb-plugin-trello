import { describe, expect, test, vi } from 'vitest';
import {
  TrelloApiError,
  isRateLimited,
  retryAfterMs,
  isAuthError
} from '../trello/client.js';
import { createTrelloApi } from '../trello/index.js';

const CREDENTIALS = { apiKey: 'key-abc', apiToken: 'token-xyz' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function rateLimited(retryAfter?: string): Response {
  return new Response(
    JSON.stringify({ error: 'API_TOKEN_LIMIT_EXCEEDED', message: 'Rate limit exceeded' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        ...(retryAfter === undefined ? {} : { 'Retry-After': retryAfter })
      }
    }
  );
}

describe('isRateLimited', () => {
  test('matches a 429 and a rate-limit body on any status', () => {
    expect(isRateLimited(new TrelloApiError('nope', 429))).toBe(true);
    expect(
      isRateLimited(new TrelloApiError('API_KEY_LIMIT_EXCEEDED', 400))
    ).toBe(true);
    expect(isRateLimited(new TrelloApiError('Rate limit exceeded', 400))).toBe(true);
    expect(isRateLimited(new TrelloApiError('not found', 404))).toBe(false);
    expect(isRateLimited(new Error('Rate limit exceeded'))).toBe(false);
  });
});

describe('isAuthError', () => {
  test('401 is the credential being wrong; 403 is a permission gap', () => {
    expect(isAuthError(new TrelloApiError('invalid key', 401))).toBe(true);
    expect(isAuthError(new TrelloApiError('invalid token', 401))).toBe(true);
    expect(
      isAuthError(new TrelloApiError('unauthorized permission requested', 401))
    ).toBe(true);
    // A 403 means the token is valid but cannot see this board — telling the
    // user to re-key the connection would send them down the wrong path.
    expect(isAuthError(new TrelloApiError('forbidden', 403))).toBe(false);
    expect(isAuthError(new TrelloApiError('not found', 404))).toBe(false);
    expect(isAuthError(new Error('invalid token'))).toBe(false);
  });
});

describe('retryAfterMs', () => {
  const headers = (value: string | null) => ({
    headers: { get: () => value }
  });

  test('reads a seconds value', () => {
    expect(retryAfterMs(headers('2'))).toBe(2000);
    expect(retryAfterMs(headers('0'))).toBe(0);
  });

  test('reads an HTTP date', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = retryAfterMs(headers(future));
    expect(parsed).not.toBeNull();
    expect(parsed!).toBeGreaterThan(1000);
    expect(parsed!).toBeLessThanOrEqual(6000);
  });

  test('returns null when absent or unparsable', () => {
    // Trello usually sends no Retry-After at all, so this is the common path.
    expect(retryAfterMs(headers(null))).toBeNull();
    expect(retryAfterMs(headers('soon'))).toBeNull();
  });
});

describe('transport retry', () => {
  test('retries a rate-limited request and returns the eventual success', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(rateLimited('0'))
        .mockResolvedValueOnce(rateLimited('0'))
        .mockResolvedValueOnce(jsonResponse([]));
      const api = createTrelloApi(CREDENTIALS, { fetchImpl });

      const pending = api.listCardAttachments('card-1');
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('gives up after the retry budget and reports the rate limit', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => rateLimited('0'));
      const api = createTrelloApi(CREDENTIALS, { fetchImpl });

      const pending = api.listCardAttachments('card-1').catch(error => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toBeInstanceOf(TrelloApiError);
      expect(isRateLimited(error)).toBe(true);
      // One initial attempt plus the retry budget.
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  test('honours a Retry-After header when Trello sends one', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(rateLimited('3'))
        .mockResolvedValueOnce(jsonResponse([]));
      const api = createTrelloApi(CREDENTIALS, { fetchImpl });
      const pending = api.listCardAttachments('card-1');

      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(pending).resolves.toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not retry a non-rate-limit failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response('card not found', { status: 404 })
      );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    await expect(api.listCardAttachments('nope')).rejects.toThrow(/not found/iu);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('reads a bare-text error body, which is Trello\'s usual shape', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('invalid token', { status: 401 }));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    const error = await api.getCard('card-1').catch(caught => caught);
    expect(error).toBeInstanceOf(TrelloApiError);
    expect((error as TrelloApiError).message).toBe('invalid token');
    expect(isAuthError(error)).toBe(true);
  });

  test('reads a JSON error envelope when there is one', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: 'ERROR_CODE', message: 'human readable' }, 400)
      );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    await expect(api.getCard('card-1')).rejects.toThrow('human readable');
  });

  test('an empty 200 body reads as null instead of a parse error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    expect(await api.getCard('card-1')).toBeNull();
  });

  test('a network failure is reported as an unreachable host', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('fetch failed'));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    await expect(api.getCard('card-1')).rejects.toThrow(/could not reach trello/iu);
  });
});
