import { describe, expect, test } from 'vitest';
import { boardViewStateSchema } from '../contract.js';

/**
 * app.tsx builds the saveBoardView payload with filterStateToPresetState().
 * That call is wrapped in a .catch(), so if the payload ever stops satisfying
 * the contract the board silently forgets its view instead of erroring — the
 * exact symptom "saving doesn't work". These tests pin the shape the UI sends.
 */
function uiPayload(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      version: 1,
      view: 'kanban',
      query: 'downloads',
      stateCategories: ['todo', 'in_progress'],
      statuses: ['Doing'],
      assignees: ['Kristof Feys'],
      labels: ['backend'],
      collapsedGroups: { done: true },
      ...overrides
    }
  };
}

describe('board view payload', () => {
  test('accepts exactly what the board sends', () => {
    const parsed = boardViewStateSchema.parse(uiPayload());
    expect(parsed.state.statuses).toEqual(['Doing']);
    expect(parsed.state.view).toBe('kanban');
  });

  test('rejects an unknown field rather than storing junk', () => {
    // A strict schema is what makes the .catch() dangerous, so prove the
    // boundary is where we think it is.
    expect(() =>
      boardViewStateSchema.parse(uiPayload({ sortOrder: 'asc' }))
    ).toThrow();
  });

  test('rejects a stale lane-grouping field from an older schema', () => {
    // Trello lanes are always the board's lists, so there is no groupBy to
    // save any more — a view carrying one is a view from another plugin.
    expect(() =>
      boardViewStateSchema.parse({ ...uiPayload(), groupBy: 'taskList' })
    ).toThrow();
  });

  test('rejects a lane facet the filter bar no longer offers', () => {
    expect(() => boardViewStateSchema.parse(uiPayload({ taskLists: ['Todo'] }))).toThrow();
    expect(() => boardViewStateSchema.parse(uiPayload({ folders: ['Scope'] }))).toThrow();
  });

  test('defaults an omitted query so a sparse view still loads', () => {
    const payload = uiPayload();
    delete (payload.state as Record<string, unknown>).query;
    expect(boardViewStateSchema.parse(payload).state.query).toBe('');
  });

  test('covers both board views the UI can produce', () => {
    for (const view of ['list', 'kanban'] as const) {
      expect(boardViewStateSchema.parse(uiPayload({ view })).state.view).toBe(view);
    }
  });
});
