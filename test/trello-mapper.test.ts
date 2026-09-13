import { describe, expect, test, vi } from 'vitest';
import {
  bodyToMarkdown,
  cardUrl,
  createdAtFromId,
  dueDateFromIso,
  mapBoard,
  mapCard,
  mapLabels,
  mapList,
  mapMember,
  markdownToBody
} from '../trello/mapper.js';
import { createTrelloApi } from '../trello/index.js';

const CREDENTIALS = { apiKey: 'key-abc', apiToken: 'token-xyz' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

const LIST = mapList({ id: 'list-1', name: 'Doing', pos: 100 });
const LISTS = new Map([[LIST.id, LIST]]);

function cardRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: '5f2a1b3c4d5e6f7a8b9c0d1e',
    idShort: 412,
    name: 'Rewrite the importer',
    desc: '# Heading\n\nSome **markdown**.',
    due: '2026-03-04T17:00:00.000Z',
    dueComplete: false,
    closed: false,
    idList: 'list-1',
    idBoard: 'board-1',
    idMembers: ['member-1'],
    labels: [{ id: 'lab-1', name: 'backend', color: 'green' }],
    shortUrl: 'https://trello.com/c/AbCdEfGh',
    dateLastActivity: '2026-01-02T03:04:05.000Z',
    members: [{ id: 'member-1', fullName: 'Ada Lovelace', username: 'ada' }],
    ...overrides
  };
}

describe('bodyToMarkdown / markdownToBody', () => {
  test('a Trello desc is already markdown, so the trip is near-identity', () => {
    expect(bodyToMarkdown('# Title\n\n- one\n- two')).toBe('# Title\n\n- one\n- two');
    expect(markdownToBody('# Title\n\n- one')).toBe('# Title\n\n- one');
  });

  test('normalises CRLF, trailing spaces, and runs of blank lines', () => {
    expect(bodyToMarkdown('a\r\nb')).toBe('a\nb');
    expect(bodyToMarkdown('a   \nb')).toBe('a\nb');
    expect(bodyToMarkdown('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(bodyToMarkdown('  padded  ')).toBe('padded');
  });

  test('a non-string body reads as empty rather than "undefined"', () => {
    expect(bodyToMarkdown(undefined)).toBe('');
    expect(bodyToMarkdown(null)).toBe('');
    expect(bodyToMarkdown(42)).toBe('');
  });

  test('markdown is not HTML-escaped on the way out', () => {
    expect(markdownToBody('<b>x</b> & y')).toBe('<b>x</b> & y');
  });
});

describe('mapLabels', () => {
  test('prefers the label name', () => {
    expect(mapLabels([{ id: 'a', name: 'bug', color: 'red' }])).toEqual(['bug']);
  });

  test('falls back to the colour when a label is unnamed', () => {
    expect(
      mapLabels([
        { id: 'a', name: '', color: 'purple' },
        { id: 'b', name: '   ', color: 'sky' }
      ])
    ).toEqual(['purple', 'sky']);
  });

  test('drops a label with neither a name nor a colour', () => {
    expect(mapLabels([{ id: 'a', name: '', color: null }])).toEqual([]);
  });

  test('a missing or non-array labels field is empty', () => {
    expect(mapLabels(undefined)).toEqual([]);
    expect(mapLabels('bug')).toEqual([]);
  });
});

describe('mapMember', () => {
  test('prefers fullName, then username', () => {
    expect(mapMember({ id: 'm', fullName: 'Ada Lovelace', username: 'ada' })?.name).toBe(
      'Ada Lovelace'
    );
    expect(mapMember({ id: 'm', fullName: '  ', username: 'ada' })?.name).toBe('ada');
    expect(mapMember({ id: 'm' })?.name).toBe('Unknown member');
  });

  test('a record with no id is not a member', () => {
    expect(mapMember({ fullName: 'Ada' })).toBeUndefined();
    expect(mapMember(undefined)).toBeUndefined();
  });

  test('completes the avatar base path Trello returns', () => {
    expect(mapMember({ id: 'm', avatarUrl: 'https://cdn.test/avatars/x' })?.avatarUrl).toBe(
      'https://cdn.test/avatars/x/170.png'
    );
    expect(mapMember({ id: 'm' })?.avatarUrl).toBeUndefined();
  });
});

describe('createdAtFromId / dueDateFromIso / cardUrl', () => {
  test('reads the creation time out of a Trello object id', () => {
    // 0x5f2a1b3c = 1596621116 seconds.
    expect(createdAtFromId('5f2a1b3c4d5e6f7a8b9c0d1e', 'fallback')).toBe(
      new Date(0x5f2a1b3c * 1000).toISOString()
    );
  });

  test('falls back when the id is not a Trello ObjectId', () => {
    expect(createdAtFromId('not-an-id', 'fallback')).toBe('fallback');
    expect(createdAtFromId('', 'fallback')).toBe('fallback');
  });

  test('a due datetime renders as a plain date', () => {
    expect(dueDateFromIso('2026-03-04T17:00:00.000Z')).toBe('2026-03-04');
    expect(dueDateFromIso(null)).toBeUndefined();
    expect(dueDateFromIso('whenever')).toBeUndefined();
  });

  test('the browse url is the card shortUrl, with a shortLink fallback', () => {
    expect(cardUrl({ shortUrl: 'https://trello.com/c/AbC' })).toBe(
      'https://trello.com/c/AbC'
    );
    expect(cardUrl({ shortLink: 'AbC' })).toBe('https://trello.com/c/AbC');
    expect(cardUrl({})).toBe('');
  });
});

describe('mapCard', () => {
  test('maps a fully populated card', () => {
    const mapped = mapCard(cardRecord(), {
      lists: LISTS,
      board: mapBoard({ id: 'board-1', name: 'Antenna' })
    });
    expect(mapped).toMatchObject({
      id: '5f2a1b3c4d5e6f7a8b9c0d1e',
      idShort: 412,
      key: '#412',
      title: 'Rewrite the importer',
      description: '# Heading\n\nSome **markdown**.',
      url: 'https://trello.com/c/AbCdEfGh',
      boardId: 'board-1',
      stateCategory: 'in_progress',
      labels: ['backend'],
      dueDate: '2026-03-04',
      updatedAt: '2026-01-02T03:04:05.000Z'
    });
    expect(mapped.status.name).toBe('Doing');
    expect(mapped.assignee?.name).toBe('Ada Lovelace');
    expect(mapped.board.name).toBe('Antenna');
  });

  test('surfaces the first of several members as the assignee', () => {
    const mapped = mapCard(
      cardRecord({
        idMembers: ['member-2', 'member-1'],
        members: [
          { id: 'member-1', fullName: 'Ada Lovelace' },
          { id: 'member-2', fullName: 'Grace Hopper' }
        ]
      }),
      { lists: LISTS }
    );
    // idMembers is the ordering that matters, not the embedded members array.
    expect(mapped.assignee?.name).toBe('Grace Hopper');
    expect(mapped.assigneeId).toBe('member-2');
    expect(mapped.memberIds).toEqual(['member-2', 'member-1']);
  });

  test('a card with no members has no assignee', () => {
    const mapped = mapCard(cardRecord({ idMembers: [], members: [] }), { lists: LISTS });
    expect(mapped.assignee).toBeUndefined();
    expect(mapped.assigneeId).toBeUndefined();
  });

  test('keeps the member id even when the member object was not expanded', () => {
    const mapped = mapCard(cardRecord({ members: undefined }), { lists: LISTS });
    expect(mapped.assignee).toBeUndefined();
    expect(mapped.assigneeId).toBe('member-1');
  });

  test('resolves an embedded list and board when no lookup is supplied', () => {
    const mapped = mapCard(
      cardRecord({
        list: { id: 'list-1', name: 'In Review', pos: 5 },
        board: { id: 'board-1', name: 'Antenna', url: 'https://trello.com/b/xyz' }
      })
    );
    expect(mapped.status.name).toBe('In Review');
    expect(mapped.stateCategory).toBe('in_progress');
    expect(mapped.board.url).toBe('https://trello.com/b/xyz');
  });

  test('falls back to the raw id for the key when idShort is missing', () => {
    const mapped = mapCard(cardRecord({ idShort: undefined }), { lists: LISTS });
    expect(mapped.key).toBe('#5f2a1b3c4d5e6f7a8b9c0d1e');
  });

  test('an empty record still produces a usable card shape', () => {
    const mapped = mapCard({});
    expect(mapped.title).toBe('Untitled card');
    expect(mapped.labels).toEqual([]);
    expect(mapped.stateCategory).toBe('todo');
    expect(mapped.description).toBe('');
  });
});

describe('card operations', () => {
  test('getCard asks for members and the embedded list and board', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(cardRecord({ list: { id: 'list-1', name: 'Doing', pos: 1 } }))
      );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    const card = await api.getCard('5f2a1b3c4d5e6f7a8b9c0d1e');

    expect(card?.key).toBe('#412');
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('members=true');
    expect(url).toContain('list=true');
    expect(url).toContain('board=true');
  });

  test('getCard returns null for a body with no id', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    expect(await api.getCard('nope')).toBeNull();
  });

  test('createCard posts idList, name, desc, member and due, then reads back', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'new-card' }))
      .mockResolvedValueOnce(jsonResponse(cardRecord({ id: 'new-card' })));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    await api.createCard({
      listId: 'list-1',
      title: 'New card',
      description: 'body',
      assigneeId: 'member-1',
      dueDate: '2026-03-04'
    });

    const created = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('POST');
    expect(created.pathname).toBe('/1/cards');
    expect(created.searchParams.get('idList')).toBe('list-1');
    expect(created.searchParams.get('name')).toBe('New card');
    expect(created.searchParams.get('desc')).toBe('body');
    expect(created.searchParams.get('idMembers')).toBe('member-1');
    expect(created.searchParams.get('due')).toBe('2026-03-04');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('createCard refuses a card with no list or no title', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    await expect(api.createCard({ listId: '', title: 'x' })).rejects.toThrow(/list is required/iu);
    await expect(api.createCard({ listId: 'l', title: '  ' })).rejects.toThrow(/title is required/iu);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a status move is a PUT of idList', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(cardRecord()))
      .mockResolvedValueOnce(jsonResponse(cardRecord({ idList: 'list-2' })));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    await api.updateCard('5f2a1b3c4d5e6f7a8b9c0d1e', { listId: 'list-2' });

    const updated = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('PUT');
    expect(updated.searchParams.get('idList')).toBe('list-2');
  });

  test('setting an assignee replaces the member set with a PUT', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(cardRecord()));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    await api.updateCard('card-1', { assigneeId: 'member-9' });
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('PUT');
    expect(
      new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get('idMembers')
    ).toBe('member-9');
  });

  test('clearing the assignee deletes each member through the documented route', async () => {
    // cardRecord() carries idMembers: ['member-1'].
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(cardRecord()));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    await api.updateCard('card-1', { assigneeId: null });

    const requests = fetchImpl.mock.calls.map(call => ({
      url: new URL(String(call[0])),
      method: call[1]?.method
    }));
    // `idMembers=` is undocumented and may 400; the removal route is not.
    expect(requests.every(request => request.url.searchParams.has('idMembers'))).toBe(
      false
    );
    const removals = requests.filter(request => request.method === 'DELETE');
    expect(removals).toHaveLength(1);
    expect(removals[0]!.url.pathname).toBe('/1/cards/card-1/idMembers/member-1');
  });

  test('an empty description clears the body rather than being dropped', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(cardRecord()));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    await api.updateCard('card-1', { description: '' });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.has('desc')).toBe(true);
    expect(url.searchParams.get('desc')).toBe('');
  });

  test('an update with nothing to change only re-reads the card', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(cardRecord()));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    await api.updateCard('card-1', {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]?.method).toBeUndefined();
  });

  test('every request carries the key and token as query parameters', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(cardRecord()));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    await api.getCard('card-1');
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.get('key')).toBe('key-abc');
    expect(url.searchParams.get('token')).toBe('token-xyz');
    // Never as headers — Trello does not read them there.
    expect(fetchImpl.mock.calls[0]![1]?.headers).not.toHaveProperty('Authorization');
  });

  test('a missing key or token fails before any request is made', () => {
    expect(() => createTrelloApi({ apiKey: '', apiToken: 'x' })).toThrow(/key and API token/iu);
    expect(() => createTrelloApi({ apiKey: 'x', apiToken: '  ' })).toThrow(/key and API token/iu);
  });

  test('getViewer maps GET /members/me', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ id: 'member-1', fullName: 'Ada Lovelace' }));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    const viewer = await api.getViewer();
    expect(viewer).toMatchObject({ id: 'member-1', name: 'Ada Lovelace' });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/1/members/me');
  });

  test('listBoards filters and sorts client-side', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse([
        { id: 'b2', name: 'Zebra', url: 'https://trello.com/b/z' },
        { id: 'b1', name: 'Antenna website', url: 'https://trello.com/b/a' },
        { id: 'b3', name: 'Internal', url: 'https://trello.com/b/i' }
      ])
    );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    expect((await api.listBoards()).map(board => board.name)).toEqual([
      'Antenna website',
      'Internal',
      'Zebra'
    ]);
    expect((await api.listBoards({ query: 'ANT' })).map(board => board.id)).toEqual(['b1']);
    expect((await api.listBoards({ limit: 2 })).map(board => board.id)).toEqual(['b1', 'b3']);
    // /members/me/boards has no query parameter, so this must not be sent.
    expect(String(fetchImpl.mock.calls[1]![0])).not.toContain('query=');
  });

});
