import { describe, expect, test, vi } from 'vitest';
import { cardStateCategory, listStateCategory, mapCard, mapList } from '../trello/mapper.js';
import { createTrelloApi } from '../trello/index.js';
import type { TrelloStateCategory } from '../trello/types.js';

const CREDENTIALS = { apiKey: 'key-abc', apiToken: 'token-xyz' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: '5f2a1b3c4d5e6f7a8b9c0d1e',
    idShort: 12,
    name: 'A card',
    desc: '',
    idList: 'list-1',
    idBoard: 'board-1',
    idMembers: [],
    labels: [],
    shortUrl: 'https://trello.com/c/AbCdEfGh',
    dateLastActivity: '2026-01-02T03:04:05.000Z',
    closed: false,
    dueComplete: false,
    ...overrides
  };
}

describe('listStateCategory', () => {
  test.each([
    ['Done', 'done'],
    ['done', 'done'],
    ['Complete', 'done'],
    ['Completed', 'done'],
    ['Closed', 'done'],
    ['Shipped', 'done'],
    ['Released', 'done'],
    ['Archive', 'done'],
    ['Archived', 'done'],
    ['DONE ✅', 'done']
  ])('%s guesses done', (name, expected) => {
    expect(listStateCategory(name)).toBe(expected as TrelloStateCategory);
  });

  test.each([
    ['Doing', 'in_progress'],
    ['In Progress', 'in_progress'],
    ['in progress', 'in_progress'],
    ['Progress', 'in_progress'],
    ['WIP', 'in_progress'],
    ['In Review', 'in_progress'],
    ['Testing', 'in_progress'],
    ['QA', 'in_progress'],
    ['Blocked', 'in_progress']
  ])('%s guesses in_progress', (name, expected) => {
    expect(listStateCategory(name)).toBe(expected as TrelloStateCategory);
  });

  test.each([
    'To Do',
    'Backlog',
    'Icebox',
    'Ideas',
    'Inbox',
    '',
    'Sprint 14'
  ])('%s falls back to todo', name => {
    expect(listStateCategory(name)).toBe('todo');
  });

  test('matches on word boundaries, not substrings', () => {
    // "Undone" and "Doingish" must not trip the done/in-progress words.
    expect(listStateCategory('Abandoned ideas')).toBe('todo');
    expect(listStateCategory('Redoing later')).toBe('todo');
  });

  test('first match wins: done outranks in progress', () => {
    expect(listStateCategory('Review done')).toBe('done');
  });
});

describe('cardStateCategory', () => {
  const list = (name: string, id = 'list-1') => mapList({ id, name, pos: 1 });

  test('uses the list-name guess when there is no override', () => {
    expect(
      cardStateCategory({
        status: list('In Review'),
        closed: false,
        dueComplete: false
      })
    ).toBe('in_progress');
  });

  test('a list id that names a prototype member is not an override', () => {
    // A plain-object lookup on `constructor` hands back a function, which then
    // fails the work-item schema and kills the whole sync.
    for (const id of ['constructor', 'toString', 'valueOf', '__proto__']) {
      const status = list('Doing', id);
      expect(cardStateCategory({ status, closed: false, dueComplete: false })).toBe(
        'in_progress'
      );
      expect(
        cardStateCategory({ status, closed: false, dueComplete: false }, { other: 'done' })
      ).toBe('in_progress');
    }
  });

  test('a per-list override corrects a guess that is wrong', () => {
    // "Icebox" reads as todo, but this team parks abandoned work there.
    const status = list('Icebox', 'list-icebox');
    expect(cardStateCategory({ status, closed: false, dueComplete: false })).toBe('todo');
    expect(
      cardStateCategory(
        { status, closed: false, dueComplete: false },
        { 'list-icebox': 'done' }
      )
    ).toBe('done');
  });

  test('an override for a different list is ignored', () => {
    expect(
      cardStateCategory(
        { status: list('Backlog', 'list-backlog'), closed: false, dueComplete: false },
        { 'list-other': 'done' }
      )
    ).toBe('todo');
  });

  test('dueComplete and closed beat both the guess and the override', () => {
    const status = list('Backlog', 'list-backlog');
    expect(cardStateCategory({ status, closed: false, dueComplete: true })).toBe('done');
    expect(cardStateCategory({ status, closed: true, dueComplete: false })).toBe('done');
    expect(
      cardStateCategory(
        { status, closed: true, dueComplete: false },
        { 'list-backlog': 'in_progress' }
      )
    ).toBe('done');
  });
});

describe('mapCard state category', () => {
  test('derives from the resolved list name', () => {
    const lists = new Map([['list-1', mapList({ id: 'list-1', name: 'Doing', pos: 1 })]]);
    expect(mapCard(card(), { lists }).stateCategory).toBe('in_progress');
  });

  test('an unresolvable list degrades to a placeholder, not a guessed name', () => {
    const mapped = mapCard(card({ idList: 'list-unknown' }));
    expect(mapped.status).toMatchObject({ id: 'list-unknown', name: 'Unknown list' });
    expect(mapped.stateCategory).toBe('todo');
  });

  test('an archived card is done even in a todo list', () => {
    const lists = new Map([['list-1', mapList({ id: 'list-1', name: 'Backlog', pos: 1 })]]);
    expect(mapCard(card({ closed: true }), { lists }).stateCategory).toBe('done');
  });
});

describe('listLists', () => {
  test('orders by pos and attaches the guessed category', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        { id: 'l3', name: 'Done', pos: 300 },
        { id: 'l1', name: 'Backlog', pos: 100 },
        { id: 'l2', name: 'Doing', pos: 200 }
      ])
    );
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    const lists = await api.listLists('board-1');

    expect(lists.map(list => list.id)).toEqual(['l1', 'l2', 'l3']);
    expect(lists.map(list => list.stateCategory)).toEqual([
      'todo',
      'in_progress',
      'done'
    ]);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('/boards/board-1/lists?filter=open');
  });

  test('an empty board id makes no request at all', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createTrelloApi(CREDENTIALS, { fetchImpl });
    expect(await api.listLists('')).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
