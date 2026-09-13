import { describe, expect, test, vi } from 'vitest';
import { BOARD_CARD_LIMIT, createTrelloApi } from '../trello/index.js';

const CREDENTIALS = { apiKey: 'key-abc', apiToken: 'token-xyz' };

const LISTS = [
  { id: 'list-1', name: 'Backlog', pos: 100 },
  { id: 'list-2', name: 'Doing', pos: 200 }
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Trello card ids are hex ObjectIds; the first 8 chars encode creation time. */
function cardId(index: number): string {
  return `${(0x5f000000 + index).toString(16)}0000000000000000`;
}

function card(index: number, idList = 'list-1', members: string[] = []) {
  return {
    id: cardId(index),
    idShort: index,
    name: `Card ${index}`,
    desc: '',
    idList,
    idBoard: 'board-1',
    idMembers: members,
    labels: [],
    shortUrl: `https://trello.com/c/c${index}`,
    closed: false,
    dueComplete: false,
    dateLastActivity: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`
  };
}

/**
 * A fetch stub that answers the lists request and then hands back the whole
 * card collection in one response — which is all Trello's board-cards route
 * does: it takes no limit and no cursor.
 */
function boardFetch(cards: ReturnType<typeof card>[]) {
  return vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/lists')) return jsonResponse(LISTS);
    return jsonResponse(cards);
  });
}

function cardRequests(fetchImpl: ReturnType<typeof boardFetch>): URL[] {
  return fetchImpl.mock.calls
    .map(call => new URL(String(call[0])))
    .filter(url => url.pathname.includes('/cards'));
}

describe('board card fetching', () => {
  test('reads the whole board in a single request', async () => {
    const fetchImpl = boardFetch([card(1), card(2), card(3)]);
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    const result = await api.listCards({ boardId: 'board-1' });
    expect(result.cards).toHaveLength(3);
    expect(result.matchedCount).toBe(3);
    // One lists request plus exactly one cards request.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [request] = cardRequests(fetchImpl);
    expect(request?.searchParams.get('before')).toBeNull();
    expect(request?.searchParams.get('limit')).toBeNull();
  });

  test('the status filter is a path segment, not a query parameter', async () => {
    const fetchImpl = boardFetch([card(1)]);
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    await api.listCards({ boardId: 'board-1', status: 'open' });
    await api.listCards({ boardId: 'board-1', status: 'all' });
    await api.listCards({ boardId: 'board-1', status: 'closed' });

    const requests = cardRequests(fetchImpl);
    expect(requests.map(url => url.pathname)).toEqual([
      '/1/boards/board-1/cards/open',
      '/1/boards/board-1/cards/all',
      '/1/boards/board-1/cards/closed'
    ]);
    // The bare /cards route documents no query parameters, so a `filter=`
    // query would be a silent no-op.
    expect(requests.every(url => url.searchParams.get('filter') === null)).toBe(true);
  });

  test('an over-ceiling board loses no card to duplication or board order', async () => {
    // Board order (list left-to-right, then `pos`) is decorrelated from
    // creation order: this response is deliberately shuffled against both the
    // card ids and the activity dates.
    const total = BOARD_CARD_LIMIT + 200;
    const created = Array.from({ length: total }, (_, index) => ({
      ...card(index + 1, index % 2 === 0 ? 'list-1' : 'list-2'),
      dateLastActivity: new Date(
        Date.UTC(2026, 0, 1) + index * 60_000
      ).toISOString()
    }));
    const boardOrder = created
      .map((entry, index) => ({ entry, key: (index * 7919) % total }))
      .sort((a, b) => a.key - b.key)
      .map(pair => pair.entry);
    const fetchImpl = boardFetch(boardOrder);
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    const result = await api.listCards({ boardId: 'board-1', limit: BOARD_CARD_LIMIT });

    expect(cardRequests(fetchImpl)).toHaveLength(1);
    expect(result.cards).toHaveLength(BOARD_CARD_LIMIT);
    // No duplicates.
    expect(new Set(result.cards.map(entry => entry.id)).size).toBe(BOARD_CARD_LIMIT);
    // The cards kept are exactly the most recently updated ones — nothing was
    // dropped out of the middle.
    const expected = created
      .slice()
      .sort(
        (a, b) =>
          new Date(b.dateLastActivity).getTime() -
          new Date(a.dateLastActivity).getTime()
      )
      .slice(0, BOARD_CARD_LIMIT)
      .map(entry => entry.id);
    expect(result.cards.map(entry => entry.id)).toEqual(expected);
    // And the truncation is signalled rather than silent.
    expect(result.matchedCount).toBe(total);
  });

  test('a board inside the ceiling reports no truncation', async () => {
    const cards = Array.from({ length: 40 }, (_, index) => card(index + 1));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl: boardFetch(cards) });
    const result = await api.listCards({ boardId: 'board-1', limit: BOARD_CARD_LIMIT });
    expect(result.matchedCount).toBe(result.cards.length);
  });

  test('an unmapped board makes no requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    expect(await api.listCards({ boardId: '' })).toEqual({ cards: [], matchedCount: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('board card scoping', () => {
  test('narrows to one list before the caller limit is applied', async () => {
    // 60 cards in another list come first, then 5 in the list we want — so a
    // limit applied before the list filter would return nothing at all.
    const cards = [
      ...Array.from({ length: 60 }, (_, index) => card(index + 1, 'list-2')),
      ...Array.from({ length: 5 }, (_, index) => card(200 + index, 'list-1'))
    ];
    const api = createTrelloApi(CREDENTIALS, { fetchImpl: boardFetch(cards) });

    const { cards: result } = await api.listCards({
      boardId: 'board-1',
      listId: 'list-1',
      limit: 10
    });
    expect(result).toHaveLength(5);
    expect(result.every(entry => entry.status.id === 'list-1')).toBe(true);
    expect(result.every(entry => entry.status.name === 'Backlog')).toBe(true);
  });

  test('narrows to one member, matching anywhere in the member set', async () => {
    const cards = [
      card(1, 'list-1', ['member-2', 'member-1']),
      card(2, 'list-1', ['member-2']),
      card(3, 'list-1', [])
    ];
    const api = createTrelloApi(CREDENTIALS, { fetchImpl: boardFetch(cards) });

    const { cards: result } = await api.listCards({
      boardId: 'board-1',
      memberId: 'member-1'
    });
    expect(result.map(entry => entry.idShort)).toEqual([1]);
  });

  test('an unscoped list still honours the caller limit', async () => {
    const cards = Array.from({ length: 40 }, (_, index) => card(index + 1));
    const api = createTrelloApi(CREDENTIALS, { fetchImpl: boardFetch(cards) });
    const result = await api.listCards({ boardId: 'board-1', limit: 10 });
    expect(result.cards).toHaveLength(10);
    expect(result.matchedCount).toBe(40);
  });

  test('results are newest-updated first', async () => {
    const cards = [
      { ...card(1), dateLastActivity: '2026-01-01T00:00:00.000Z' },
      { ...card(2), dateLastActivity: '2026-03-01T00:00:00.000Z' },
      { ...card(3), dateLastActivity: '2026-02-01T00:00:00.000Z' }
    ];
    const api = createTrelloApi(CREDENTIALS, { fetchImpl: boardFetch(cards) });
    const { cards: result } = await api.listCards({ boardId: 'board-1' });
    expect(result.map(entry => entry.idShort)).toEqual([2, 3, 1]);
  });

  test('member names resolve without a follow-up request per card', async () => {
    const cards = [card(1, 'list-1', ['member-1'])];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/lists')) return jsonResponse(LISTS);
      return jsonResponse(
        cards.map(entry => ({
          ...entry,
          members: [{ id: 'member-1', fullName: 'Ada Lovelace' }]
        }))
      );
    });
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });

    const { cards: result } = await api.listCards({ boardId: 'board-1' });
    expect(result[0]?.assignee?.name).toBe('Ada Lovelace');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const cardsUrl = new URL(String(fetchImpl.mock.calls[1]![0]));
    expect(cardsUrl.searchParams.get('members')).toBe('true');
    expect(cardsUrl.searchParams.get('member_fields')).toContain('fullName');
  });
});

describe('board members', () => {
  test('maps the assignable member list', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse([
          { id: 'member-1', fullName: 'Ada Lovelace', username: 'ada' },
          { id: 'member-2', username: 'grace' },
          { notAMember: true }
        ])
      );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    const members = await api.listBoardMembers('board-1');
    expect(members.map(member => member.name)).toEqual(['Ada Lovelace', 'grace']);
  });

  test('an empty board id makes no request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    expect(await api.listBoardMembers('')).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
