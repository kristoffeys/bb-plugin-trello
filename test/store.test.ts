import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { FILTER_PRESET_LIMIT, type FilterPreset, type WorkItem } from '../contract.js';
import { createWorkItemStore, type WorkItemStore } from '../store.js';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

const PROJECT = 'proj_alpha';
const OTHER = 'proj_beta';

let db: Database.Database;
let store: WorkItemStore;

// Mirrors the real bb.storage.migrate contract: each migration in the array
// runs at most once per database, tracked by index.
let warnings: string[] = [];

function fakeBb(handle: Database.Database): BbPluginApi {
  return {
    log: { warn: (message: string) => warnings.push(message) },
    storage: {
      database: () => handle,
      migrate: (target: Database.Database, statements: string[]) => {
        target.exec(
          'CREATE TABLE IF NOT EXISTS _applied_migrations (idx INTEGER PRIMARY KEY)'
        );
        const applied = new Set(
          target
            .prepare('SELECT idx FROM _applied_migrations')
            .all()
            .map((row: unknown) => (row as { idx: number }).idx)
        );
        statements.forEach((statement, index) => {
          if (applied.has(index)) return;
          target.exec(statement);
          target
            .prepare('INSERT INTO _applied_migrations (idx) VALUES (?)')
            .run(index);
        });
      }
    }
  } as unknown as BbPluginApi;
}

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    bbProjectId: PROJECT,
    locator: '5f2a1b3c4d5e6f7a8b9c0d1e',
    key: '#1',
    title: 'Ship the board',
    description: 'Card description',
    url: 'https://trello.com/c/AbCdEfGh',
    status: 'To Do',
    statusId: 'list-todo',
    stateCategory: 'todo',
    assignee: 'Kristof',
    assigneeId: 'member-99',
    board: 'Antenna',
    boardId: 'board-500',
    labels: ['frontend'],
    dueDate: '2026-01-01',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function presetState(query = ''): FilterPreset['state'] {
  return {
    version: 1,
    view: 'list',
    query,
    stateCategories: [],
    statuses: [],
    assignees: [],
    labels: [],
    collapsedGroups: {}
  };
}

const SCOPE_DEFAULTS = {
  boardId: '',
  assignedToMeOnly: false,
  includeClosed: false,
  listCategories: {}
};

beforeEach(() => {
  warnings = [];
  db = new Database(':memory:');
  store = createWorkItemStore(fakeBb(db));
});

describe('work item cache', () => {
  it('replaceAll swaps the previous set inside one project', () => {
    store.replaceAll(
      PROJECT,
      [item({ locator: '1' }), item({ locator: '2', key: '#2' })],
      '2026-01-01T10:00:00.000Z'
    );
    store.replaceAll(OTHER, [item({ bbProjectId: OTHER, locator: '9' })], 'x');

    store.replaceAll(
      PROJECT,
      [item({ locator: '2', key: '#2', title: 'Renamed' })],
      '2026-01-02T10:00:00.000Z'
    );

    const items = store.list({ projectId: PROJECT, limit: 50 });
    expect(items.map(entry => entry.locator)).toEqual(['2']);
    expect(items[0]?.title).toBe('Renamed');
    expect(store.get(PROJECT, '1')).toBeNull();
    expect(store.list({ projectId: OTHER, limit: 50 })).toHaveLength(1);

    const status = store.syncStatus(PROJECT);
    expect(status.lastSyncedAt).toBe('2026-01-02T10:00:00.000Z');
    expect(status.itemCount).toBe(1);
    expect(status.available).toBe(true);
  });

  it('skips one unreadable card instead of failing the whole sync', () => {
    const bad = { ...item({ locator: 'bad' }), stateCategory: 'nonsense' } as WorkItem;
    store.replaceAll(
      PROJECT,
      [item({ locator: 'good-1' }), bad, item({ locator: 'good-2', key: '#2' })],
      '2026-01-03T10:00:00.000Z'
    );

    const items = store.list({ projectId: PROJECT, limit: 50 });
    expect(items.map(entry => entry.locator).sort()).toEqual(['good-1', 'good-2']);
    const status = store.syncStatus(PROJECT);
    expect(status.itemCount).toBe(2);
    expect(status.available).toBe(true);
    // Dropped silently is the bug; the warning is what makes it diagnosable.
    expect(warnings.join(' ')).toContain('skipped 1');
  });

  it('carries a sync notice in the status message without going unavailable', () => {
    store.replaceAll(PROJECT, [item()], '2026-01-03T10:00:00.000Z', 'Showing 1 of 9.');
    expect(store.syncStatus(PROJECT)).toMatchObject({
      available: true,
      message: 'Showing 1 of 9.'
    });

    // An error supersedes the notice, and a clean sync clears it again.
    store.setSyncError(PROJECT, 'Could not reach Trello.');
    expect(store.syncStatus(PROJECT)).toMatchObject({
      available: false,
      message: 'Could not reach Trello.'
    });
    store.replaceAll(PROJECT, [item()], '2026-01-04T10:00:00.000Z');
    expect(store.syncStatus(PROJECT).message).toBeNull();
  });

  it('rejects items from another bb project', () => {
    expect(() =>
      store.replaceAll(PROJECT, [item({ bbProjectId: OTHER })], 'now')
    ).toThrow();
    expect(() => store.upsert(PROJECT, item({ bbProjectId: OTHER }))).toThrow();
  });

  it('upsert refreshes a single cached row', () => {
    store.replaceAll(PROJECT, [item()], 'now');
    store.upsert(
      PROJECT,
      item({ status: 'Done', statusId: 'list-done', stateCategory: 'done' })
    );
    expect(store.get(PROJECT, item().locator)?.stateCategory).toBe('done');
    expect(store.list({ projectId: PROJECT, limit: 50 })).toHaveLength(1);
  });

  it('round-trips the board name and id', () => {
    store.replaceAll(PROJECT, [item()], 'now');
    expect(store.get(PROJECT, item().locator)).toMatchObject({
      board: 'Antenna',
      boardId: 'board-500'
    });
    store.upsert(PROJECT, item({ board: 'Other', boardId: 'board-501' }));
    expect(store.get(PROJECT, item().locator)).toMatchObject({
      board: 'Other',
      boardId: 'board-501'
    });
  });

  it('reads a row with NULL board columns defensively', () => {
    store.replaceAll(PROJECT, [item()], 'now');
    db.prepare('UPDATE work_items SET board = NULL, board_id = NULL').run();
    expect(store.get(PROJECT, item().locator)).toMatchObject({
      board: null,
      boardId: null
    });
  });

  it('filters by query and by state categories', () => {
    store.replaceAll(
      PROJECT,
      [
        item({ locator: '1', key: '#1', title: 'Fix login bug', stateCategory: 'todo' }),
        item({
          locator: '2',
          key: '#2',
          title: 'Write docs',
          description: 'nothing here',
          stateCategory: 'in_progress'
        }),
        item({
          locator: '3',
          key: '#3',
          title: 'Archive',
          description: 'login rewrite',
          stateCategory: 'done'
        })
      ],
      'now'
    );

    expect(
      store.list({ projectId: PROJECT, query: 'LOGIN', limit: 50 }).map(i => i.locator)
    ).toEqual(['1', '3']);
    expect(
      store
        .list({ projectId: PROJECT, stateCategories: ['todo', 'done'], limit: 50 })
        .map(i => i.locator)
    ).toEqual(['1', '3']);
    expect(
      store.list({
        projectId: PROJECT,
        query: 'login',
        stateCategories: ['done'],
        limit: 50
      }).map(i => i.locator)
    ).toEqual(['3']);
    // LIKE wildcards in the query are literal, not patterns.
    expect(store.list({ projectId: PROJECT, query: '%', limit: 50 })).toEqual([]);
    expect(store.list({ projectId: PROJECT, limit: 2 })).toHaveLength(2);
  });

  it('searches the list name, which is where the status lives now', () => {
    store.replaceAll(
      PROJECT,
      [
        item({ locator: '1', status: 'In Review', statusId: 'list-review' }),
        item({ locator: '2', status: 'Backlog', statusId: 'list-backlog' })
      ],
      'now'
    );
    expect(
      store.list({ projectId: PROJECT, query: 'review', limit: 50 }).map(i => i.locator)
    ).toEqual(['1']);
  });

  it('records a sync error without dropping cached rows', () => {
    store.replaceAll(PROJECT, [item()], '2026-01-01T10:00:00.000Z');
    store.setSyncError(PROJECT, 'Trello is down');
    const status = store.syncStatus(PROJECT);
    expect(status.available).toBe(false);
    expect(status.message).toBe('Trello is down');
    expect(status.itemCount).toBe(1);
    expect(store.list({ projectId: PROJECT, limit: 50 })).toHaveLength(1);
  });
});

describe('project scope', () => {
  it('falls back to defaults and round-trips a saved scope', () => {
    expect(store.projectScope(PROJECT, SCOPE_DEFAULTS)).toEqual({
      projectId: PROJECT,
      ...SCOPE_DEFAULTS
    });
    const saved = store.saveProjectScope({
      projectId: PROJECT,
      boardId: 'board-500',
      assignedToMeOnly: true,
      includeClosed: false,
      listCategories: {}
    });
    expect(saved.assignedToMeOnly).toBe(true);
    expect(store.projectScope(PROJECT, SCOPE_DEFAULTS)).toEqual(saved);
  });

  it('persists per-list category overrides', () => {
    store.saveProjectScope({
      projectId: PROJECT,
      boardId: 'board-500',
      assignedToMeOnly: false,
      includeClosed: false,
      listCategories: { 'list-icebox': 'todo', 'list-ship-it': 'done' }
    });
    expect(store.projectScope(PROJECT, SCOPE_DEFAULTS).listCategories).toEqual({
      'list-icebox': 'todo',
      'list-ship-it': 'done'
    });
  });

  it('changing only the overrides keeps the cached cards', () => {
    store.saveProjectScope({
      ...SCOPE_DEFAULTS,
      projectId: PROJECT,
      boardId: 'board-500'
    });
    store.replaceAll(PROJECT, [item()], 'now');
    store.saveProjectScope({
      ...SCOPE_DEFAULTS,
      projectId: PROJECT,
      boardId: 'board-500',
      listCategories: { 'list-todo': 'in_progress' }
    });
    // The next sync re-derives them; there is no need to blank the board first.
    expect(store.list({ projectId: PROJECT, limit: 50 })).toHaveLength(1);
  });

  it('drops an override map that no longer parses instead of failing the read', () => {
    store.saveProjectScope({
      ...SCOPE_DEFAULTS,
      projectId: PROJECT,
      boardId: 'board-500',
      listCategories: { 'list-a': 'done' }
    });
    db.prepare('UPDATE project_scope SET list_categories_json = ?').run('{nope');
    expect(store.projectScope(PROJECT, SCOPE_DEFAULTS).listCategories).toEqual({});

    db.prepare('UPDATE project_scope SET list_categories_json = ?').run(
      JSON.stringify({ 'list-a': 'shipped' })
    );
    expect(store.projectScope(PROJECT, SCOPE_DEFAULTS).listCategories).toEqual({});
  });

  it('configuredProjectIds lists only mapped projects', () => {
    store.saveProjectScope({ projectId: PROJECT, ...SCOPE_DEFAULTS, boardId: 'board-500' });
    store.saveProjectScope({ projectId: OTHER, ...SCOPE_DEFAULTS });
    expect(store.configuredProjectIds()).toEqual([PROJECT]);
  });

  it('drops the cache when the board is retargeted', () => {
    store.saveProjectScope({ projectId: PROJECT, ...SCOPE_DEFAULTS, boardId: 'board-500' });
    store.replaceAll(PROJECT, [item()], 'now');
    store.saveProjectScope({ projectId: PROJECT, ...SCOPE_DEFAULTS, boardId: 'board-501' });
    expect(store.list({ projectId: PROJECT, limit: 50 })).toEqual([]);
    expect(store.syncStatus(PROJECT).lastSyncedAt).toBeNull();
  });
});

describe('board settings', () => {
  it('defaults, saves, and survives a malformed json column', () => {
    const defaults = store.boardSettings(PROJECT);
    expect(defaults.projectId).toBe(PROJECT);

    const saved = store.saveBoardSettings({ ...defaults, defaultView: 'kanban' });
    expect(saved.defaultView).toBe('kanban');

    db.prepare('UPDATE project_board_settings SET status_order_json = ?').run('{oops');
    expect(store.boardSettings(PROJECT).statusOrder).toEqual(defaults.statusOrder);
  });

  it('the default filter set has no lane facet beyond the list', () => {
    expect(store.boardSettings(PROJECT).enabledFilters).toEqual([
      'state',
      'status',
      'assignee',
      'labels'
    ]);
  });
});

describe('filter presets', () => {
  it('enforces the preset limit', () => {
    for (let index = 0; index < FILTER_PRESET_LIMIT; index += 1) {
      store.savePreset({ projectId: PROJECT, name: `Preset ${index}`, state: presetState() });
    }
    expect(store.listPresets(PROJECT)).toHaveLength(FILTER_PRESET_LIMIT);
    expect(() =>
      store.savePreset({ projectId: PROJECT, name: 'One too many', state: presetState() })
    ).toThrow(/at most/u);
  });

  it('rejects a duplicate normalized name but allows renaming in place', () => {
    const first = store.savePreset({
      projectId: PROJECT,
      name: 'My Filter',
      state: presetState()
    });
    expect(() =>
      store.savePreset({ projectId: PROJECT, name: 'my filter', state: presetState() })
    ).toThrow(/already exists/u);
    const updated = store.savePreset({
      projectId: PROJECT,
      id: first.id,
      name: 'My Filter',
      state: presetState('changed')
    });
    expect(updated.id).toBe(first.id);
    expect(updated.state.query).toBe('changed');
    expect(
      store.savePreset({ projectId: OTHER, name: 'My Filter', state: presetState() }).id
    ).not.toBe(first.id);
    expect(store.listPresets(PROJECT)).toHaveLength(1);
  });

  it('reorders and renumbers after a delete', () => {
    const a = store.savePreset({ projectId: PROJECT, name: 'A', state: presetState() });
    const b = store.savePreset({ projectId: PROJECT, name: 'B', state: presetState() });
    const c = store.savePreset({ projectId: PROJECT, name: 'C', state: presetState() });

    const reordered = store.reorderPresets(PROJECT, [c.id, a.id, b.id]);
    expect(reordered.map(preset => preset.name)).toEqual(['C', 'A', 'B']);

    const remaining = store.deletePreset(PROJECT, a.id);
    expect(remaining.map(preset => preset.name)).toEqual(['C', 'B']);
    expect(remaining.map(preset => preset.position)).toEqual([0, 1]);
    expect(store.deletePreset(PROJECT, b.id)).toHaveLength(1);
    expect(store.deletePreset(PROJECT, b.id)).toHaveLength(1);
  });

  it('hides a preset with a malformed filters_json instead of throwing', () => {
    const good = store.savePreset({ projectId: PROJECT, name: 'Good', state: presetState() });
    const bad = store.savePreset({ projectId: PROJECT, name: 'Bad', state: presetState() });
    db.prepare('UPDATE project_filter_presets SET filters_json = ? WHERE id = ?').run(
      'not json',
      bad.id
    );

    expect(store.listPresets(PROJECT).map(preset => preset.id)).toEqual([good.id]);
    expect(store.reorderPresets(PROJECT, [good.id])).toHaveLength(1);
  });

  it('keeps a work item readable when labels_json is corrupt', () => {
    store.replaceAll(PROJECT, [item()], 'now');
    db.prepare('UPDATE work_items SET labels_json = ?').run('<not json>');
    expect(store.get(PROJECT, item().locator)?.labels).toEqual([]);
    expect(store.list({ projectId: PROJECT, limit: 50 })).toHaveLength(1);
  });
});
