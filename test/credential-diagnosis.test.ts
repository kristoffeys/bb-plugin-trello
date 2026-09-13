import { describe, expect, test, vi } from 'vitest';
import {
  TrelloApiError,
  authFaultMessage,
  diagnoseCredentialFault
} from '../trello/index.js';

// The bug this file guards: Trello answers a token that does not belong to the
// key with 401 "invalid key", so the plugin used to send the user off to
// regenerate the one credential that was fine.
const API_KEY = 'k0000000000000000000abcd';
const API_TOKEN = 't1111111111111111111111111111111111111111111111111111111111111wxyz';
const CREDENTIALS = { apiKey: API_KEY, apiToken: API_TOKEN };

const invalidKey = new TrelloApiError('invalid key', 401);

function probe(response: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>().mockImplementation(async () => response());
}

describe('diagnoseCredentialFault', () => {
  test('blames the token when the key alone is accepted', async () => {
    const fetchImpl = probe(() => new Response('invalid token', { status: 400 }));

    expect(await diagnoseCredentialFault(invalidKey, CREDENTIALS, { fetchImpl })).toBe(
      'token'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain('/1/members/me');
    expect(url).not.toContain('token=');
  });

  test('blames the key when the key alone is rejected too', async () => {
    const fetchImpl = probe(() => new Response('invalid key', { status: 401 }));

    expect(await diagnoseCredentialFault(invalidKey, CREDENTIALS, { fetchImpl })).toBe(
      'key'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('blames the token when the key alone works outright', async () => {
    const fetchImpl = probe(() => new Response('{"id":"1"}', { status: 200 }));

    expect(await diagnoseCredentialFault(invalidKey, CREDENTIALS, { fetchImpl })).toBe(
      'token'
    );
  });

  test('does not probe when no token is configured', async () => {
    const fetchImpl = probe(() => new Response('invalid token', { status: 400 }));

    expect(
      await diagnoseCredentialFault(
        invalidKey,
        { apiKey: API_KEY, apiToken: '' },
        { fetchImpl }
      )
    ).toBe('key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('does not probe when Trello did not blame the key', async () => {
    const fetchImpl = probe(() => new Response('invalid token', { status: 400 }));

    for (const error of [
      new TrelloApiError('invalid token', 401),
      new TrelloApiError('Trello request failed', 500),
      // The success path never reaches here at all; this is its stand-in.
      null
    ]) {
      await diagnoseCredentialFault(error, CREDENTIALS, { fetchImpl });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('keeps Trello’s verdict when the probe cannot reach Trello', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));

    expect(await diagnoseCredentialFault(invalidKey, CREDENTIALS, { fetchImpl })).toBe(
      'key'
    );
  });

  test('keeps Trello’s verdict when the probe is rate limited', async () => {
    const fetchImpl = probe(
      () => new Response('API_KEY_LIMIT_EXCEEDED', { status: 429 })
    );

    expect(await diagnoseCredentialFault(invalidKey, CREDENTIALS, { fetchImpl })).toBe(
      'key'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('never logs a credential, whatever the probe echoes back', async () => {
    // The realistic leak: a gateway that repeats the URL it could not serve.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async input =>
        new Response(`failed for ${String(input)}`, { status: 502 })
      );
    const logged: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      })
    );

    try {
      expect(await diagnoseCredentialFault(invalidKey, CREDENTIALS, { fetchImpl })).toBe(
        'token'
      );
      expect(logged).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('authFaultMessage', () => {
  test('points a bad token at the Connect flow, not at the admin page', () => {
    const message = authFaultMessage('token', 'http://127.0.0.1:38886');
    expect(message).toMatch(/invalid or expired/iu);
    expect(message).toMatch(/connect trello again/iu);
    // Allowed origins are a different failure; naming them here misleads.
    expect(message).not.toContain('power-ups/admin');
    expect(message).not.toMatch(/allowed origins/iu);
  });

  test('points a bad key at its Power-Up and allowed origins', () => {
    const message = authFaultMessage('key', 'http://127.0.0.1:38886');
    expect(message).toContain('https://trello.com/power-ups/admin');
    expect(message).toContain('http://127.0.0.1:38886');
    expect(message).toMatch(/allowed origins/iu);
  });

  test('falls back to a generic address when the server is not listening', () => {
    expect(authFaultMessage('key', '')).toContain("BB's address");
  });

  test('says both are suspect when Trello did not name one', () => {
    expect(authFaultMessage(null, '')).toBe(
      'Trello rejected the API key or token. Update the connection.'
    );
  });
});
