import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { createWorkItemStore } from '../store.js';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

/** Minimal stand-in for the plugin API surface the store actually uses. */
function testStore() {
  const db = new Database(':memory:');
  const applied: string[] = [];
  const bb = {
    storage: {
      database: () => db,
      migrate: (target: Database.Database, migrations: readonly string[]) => {
        for (const migration of migrations) {
          if (applied.includes(migration)) continue;
          target.exec(migration);
          applied.push(migration);
        }
      }
    }
  } as unknown as BbPluginApi;
  return { store: createWorkItemStore(bb), db };
}

const VIEW = {
  state: {
    version: 1,
    view: 'kanban',
    query: 'search',
    stateCategories: ['todo'],
    statuses: ['Doing'],
    assignees: ['Kristof'],
    labels: [],
    collapsedGroups: { done: true }
  }
};

describe('board view persistence', () => {
  test('round-trips the saved view', () => {
    const { store } = testStore();
    expect(store.readBoardView('proj_a')).toBeNull();

    store.writeBoardView('proj_a', VIEW);
    expect(store.readBoardView('proj_a')).toEqual(VIEW);
  });

  test('overwrites rather than accumulating rows', () => {
    const { store, db } = testStore();
    store.writeBoardView('proj_a', VIEW);
    store.writeBoardView('proj_a', {
      ...VIEW,
      state: { ...VIEW.state, view: 'list' }
    });

    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM project_board_view')
      .get() as { n: number };
    expect(rows.n).toBe(1);
    expect((store.readBoardView('proj_a') as typeof VIEW).state.view).toBe('list');
  });

  test('keeps projects independent', () => {
    const { store } = testStore();
    store.writeBoardView('proj_a', VIEW);
    expect(store.readBoardView('proj_b')).toBeNull();
  });

  test('a corrupt row reads as null instead of throwing', () => {
    const { store, db } = testStore();
    db.prepare(
      `INSERT INTO project_board_view (bb_project_id, view_json, updated_at)
       VALUES (?, ?, ?)`
    ).run('proj_a', '{not json', new Date().toISOString());

    // The board must still open; a broken row is simply forgotten.
    expect(store.readBoardView('proj_a')).toBeNull();
  });
});
