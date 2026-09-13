import { describe, expect, test, vi } from 'vitest';
import { createTrelloApi, stripCredentialQueryParams } from '../trello/index.js';

// The hazard this whole file exists for: Trello takes both credentials as
// query parameters, so every request URL contains them. Anything that echoes
// a URL back — an upstream error body, a fetch TypeError, a proxy page — leaks
// the pair unless the transport scrubs it.
const API_KEY = 'k0000000000000000000abcd';
const API_TOKEN = 't1111111111111111111111111111111111111111111111111111111111111wxyz';
const CREDENTIALS = { apiKey: API_KEY, apiToken: API_TOKEN };

function expectNoCredentials(text: string): void {
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain(API_TOKEN);
}

describe('stripCredentialQueryParams', () => {
  test('redacts key and token in a URL, leaving the rest readable', () => {
    expect(
      stripCredentialQueryParams(
        `https://api.trello.com/1/cards/abc?fields=name&key=${API_KEY}&token=${API_TOKEN}`
      )
    ).toBe('https://api.trello.com/1/cards/abc?fields=name&key=[redacted]&token=[redacted]');
  });

  test('redacts whichever parameter comes first', () => {
    expect(
      stripCredentialQueryParams(`https://api.trello.com/1/members/me?token=${API_TOKEN}`)
    ).toBe('https://api.trello.com/1/members/me?token=[redacted]');
  });

  test('is case-insensitive about the parameter name', () => {
    expect(stripCredentialQueryParams('https://x.test/?KEY=abc&Token=def')).toBe(
      'https://x.test/?KEY=[redacted]&Token=[redacted]'
    );
  });

  test('stops at a quote or bracket so surrounding prose survives', () => {
    expect(
      stripCredentialQueryParams(
        `request to "https://api.trello.com/1/cards?key=${API_KEY}" failed`
      )
    ).toBe('request to "https://api.trello.com/1/cards?key=[redacted]" failed');
  });

  test('leaves an unrelated parameter alone', () => {
    expect(stripCredentialQueryParams('https://x.test/?keyword=hello')).toBe(
      'https://x.test/?keyword=hello'
    );
  });
});

describe('errors never carry the credentials', () => {
  test('an upstream error body that echoes the request URL is scrubbed', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async input =>
      // The realistic leak: a gateway that repeats the URL it could not serve.
      new Response(`Bad gateway while proxying ${String(input)}`, { status: 502 })
    );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    const error = await api.getCard('card-1').catch(caught => caught);
    const message = String((error as Error).message);
    expectNoCredentials(message);
    expect(message).toContain('key=[redacted]');
    expect(message).toContain('token=[redacted]');
  });

  test('an error body that quotes a bare credential is scrubbed too', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(`invalid token: ${API_TOKEN} (key ${API_KEY})`, { status: 401 })
      );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    const error = await api.getCard('card-1').catch(caught => caught);
    const message = String((error as Error).message);
    expectNoCredentials(message);
    expect(message).toContain('[redacted]');
  });

  test('a network failure whose message contains the URL is scrubbed', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async input => {
      throw new TypeError(`fetch failed for ${String(input)}`);
    });
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    const error = await api.listCards({ boardId: 'board-1' }).catch(caught => caught);
    expectNoCredentials(String((error as Error).message));
  });

  test('an unparsable response body cannot leak them either', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{ not json', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    const error = await api.getCard('card-1').catch(caught => caught);
    expectNoCredentials(String((error as Error).message));
  });

  test('a rate-limit body naming the token is scrubbed before the retry gives up', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(
          async () =>
            new Response(`API_TOKEN_LIMIT_EXCEEDED for ${API_TOKEN}`, { status: 429 })
        );
      const api = createTrelloApi(CREDENTIALS, { fetchImpl });
      const pending = api.listCardAttachments('card-1').catch(caught => caught);
      await vi.runAllTimersAsync();
      const error = await pending;
      expectNoCredentials(String((error as Error).message));
      expect(String((error as Error).message)).toContain('[redacted]');
    } finally {
      vi.useRealTimers();
    }
  });

  test('the whole serialised error is clean, not just the message', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async input => new Response(String(input), { status: 500 }));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    const error = await api.getViewer().catch(caught => caught);
    expectNoCredentials(JSON.stringify({ ...(error as object), message: (error as Error).message }));
    expectNoCredentials(String(error));
  });
});
