import { describe, expect, test, vi } from 'vitest';
import { mapAttachment, mapComment } from '../trello/mapper.js';
import { createTrelloApi } from '../trello/index.js';

const CREDENTIALS = { apiKey: 'key-abc', apiToken: 'token-xyz' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('mapAttachment', () => {
  test('maps the fields the board renders', () => {
    const mapped = mapAttachment({
      id: '5f2a1b3c4d5e6f7a8b9c0d1e',
      name: 'screenshot.png',
      mimeType: 'image/png',
      bytes: 493_568,
      url: 'https://trello.com/1/cards/x/attachments/y/download/screenshot.png',
      date: '2026-02-03T04:05:06.000Z',
      previews: [
        { url: 'https://trello.com/preview/small.png', width: 70 },
        { url: 'https://trello.com/preview/large.png', width: 600 }
      ]
    });
    expect(mapped).toMatchObject({
      id: '5f2a1b3c4d5e6f7a8b9c0d1e',
      name: 'screenshot.png',
      contentType: 'image/png',
      size: 493_568,
      isImage: true,
      thumbUrl: 'https://trello.com/preview/small.png',
      createdAt: '2026-02-03T04:05:06.000Z',
      attachedTo: 'card'
    });
  });

  test('a link attachment has no bytes and no preview', () => {
    const mapped = mapAttachment({
      id: 'a1',
      name: 'Design doc',
      mimeType: '',
      bytes: null,
      url: 'https://example.test/doc',
      date: '2026-02-03T04:05:06.000Z'
    });
    expect(mapped.size).toBe(0);
    expect(mapped.thumbUrl).toBeUndefined();
    expect(mapped.isImage).toBe(false);
  });

  test('falls back to the file extension when Trello omits the mime type', () => {
    expect(mapAttachment({ id: 'a', name: 'diagram.PNG', mimeType: '' }).isImage).toBe(true);
    expect(mapAttachment({ id: 'a', name: 'notes.txt', mimeType: '' }).isImage).toBe(false);
    // A declared non-image mime type wins over a misleading name.
    expect(
      mapAttachment({ id: 'a', name: 'trap.png', mimeType: 'application/pdf' }).isImage
    ).toBe(false);
  });

  test('an empty record still maps to a renderable attachment', () => {
    const mapped = mapAttachment({});
    expect(mapped.name).toBe('Untitled attachment');
    expect(mapped.url).toBe('');
    expect(mapped.size).toBe(0);
  });

  test('the created date falls back to the id timestamp', () => {
    expect(mapAttachment({ id: '5f2a1b3c4d5e6f7a8b9c0d1e' }).createdAt).toBe(
      new Date(0x5f2a1b3c * 1000).toISOString()
    );
  });
});

describe('mapComment', () => {
  test('reads the author from memberCreator and the body from data.text', () => {
    const mapped = mapComment({
      id: 'action-1',
      date: '2026-02-03T04:05:06.000Z',
      data: { text: 'Looks good to me' },
      memberCreator: { id: 'member-1', fullName: 'Ada Lovelace' }
    });
    expect(mapped).toMatchObject({
      id: 'action-1',
      body: 'Looks good to me',
      createdAt: '2026-02-03T04:05:06.000Z'
    });
    expect(mapped.user?.name).toBe('Ada Lovelace');
    // Trello attaches files to cards, never to a comment action.
    expect(mapped.attachments).toEqual([]);
  });

  test('surfaces an edit timestamp when there is one', () => {
    expect(
      mapComment({ id: 'a', data: { text: 'x' }, dateLastEdited: '2026-02-04T00:00:00.000Z' })
        .updatedAt
    ).toBe('2026-02-04T00:00:00.000Z');
    expect(mapComment({ id: 'a', data: { text: 'x' } }).updatedAt).toBeUndefined();
  });

  test('a malformed action degrades to an empty body, not a crash', () => {
    expect(mapComment({}).body).toBe('');
    expect(mapComment({ id: 'a', data: 'not an object' }).body).toBe('');
  });
});

describe('listCardAttachments', () => {
  test('requests only the fields the board uses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        jsonResponse([{ id: 'a1', name: 'x.png', mimeType: 'image/png' }])
      );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    const attachments = await api.listCardAttachments('card-1');

    expect(attachments).toHaveLength(1);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('/cards/card-1/attachments');
    expect(url).toContain('fields=id,name,mimeType,bytes,url,previews,date');
  });

  test('a non-array body is an empty attachment list, not a throw', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'nope' }));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    expect(await api.listCardAttachments('card-1')).toEqual([]);
  });
});

describe('getCardComments', () => {
  test('filters the activity feed down to comments and sorts oldest first', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        {
          id: 'a2',
          date: '2026-02-05T00:00:00.000Z',
          data: { text: 'second' },
          memberCreator: { id: 'm1', fullName: 'Ada' }
        },
        {
          id: 'a1',
          date: '2026-02-04T00:00:00.000Z',
          data: { text: 'first' },
          memberCreator: { id: 'm2', fullName: 'Grace' }
        }
      ])
    );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    const comments = await api.getCardComments('card-1');

    expect(comments.map(comment => comment.body)).toEqual(['first', 'second']);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('filter=commentCard');
    expect(url).toContain('memberCreator=true');
  });

  test('addCardComment posts the text and maps the returned action', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: 'a1',
        date: '2026-02-05T00:00:00.000Z',
        data: { text: 'Shipped it' },
        memberCreator: { id: 'm1', fullName: 'Ada' }
      })
    );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    const comment = await api.addCardComment('card-1', 'Shipped it');

    expect(comment.body).toBe('Shipped it');
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('POST');
    expect(url.pathname).toBe('/1/cards/card-1/actions/comments');
    expect(url.searchParams.get('text')).toBe('Shipped it');
  });
});
