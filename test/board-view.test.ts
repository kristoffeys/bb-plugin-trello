import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  NO_LABELS_FILTER,
  UNASSIGNED_ASSIGNEE_FILTER,
  assigneeAvatarIdentity,
  assigneeFilterOptions,
  canonicalizeSelectedFilterOptions,
  filterWorkItemsByAttributes,
  formatAttachmentSize,
  isGroupCollapsed,
  labelFilterOptions,
  sortWorkItemsByWorkflow,
  statusFilterOptions,
  toggleFilterOptionSelection,
  toggleGroupCollapsedOverride,
  workflowStatusGroups,
  workflowStatusLaneKey,
  workflowStatusLanes,
  workflowStatusTone
} from '../board-view.ts';
import type { WorkItem, WorkStatusOption } from '../contract.ts';

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    bbProjectId: 'proj_a',
    locator: '1',
    key: '#1',
    title: 'Card',
    description: '',
    url: 'https://trello.com/c/AbCdEfGh',
    status: 'To Do',
    statusId: 'list-todo',
    stateCategory: 'todo',
    assignee: null,
    assigneeId: null,
    board: 'Website',
    boardId: 'board-1',
    labels: [],
    dueDate: null,
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('workflowStatusGroups groups by list and orders by the board order', () => {
  const items = [
    item({ locator: '1', status: 'Done', stateCategory: 'done' }),
    item({ locator: '2', status: 'Doing', stateCategory: 'in_progress' }),
    item({ locator: '3', status: 'To Do', stateCategory: 'todo' }),
    item({ locator: '4', status: 'Doing', stateCategory: 'in_progress' })
  ];
  const groups = workflowStatusGroups(items);
  // DEFAULT_WORKFLOW_STATUS_ORDER is ['To Do', 'Doing', 'Done'].
  assert.deepEqual(
    groups.map(group => group.name),
    ['To Do', 'Doing', 'Done']
  );
  assert.equal(groups.find(group => group.name === 'Doing')?.items.length, 2);
});

test('a board-supplied list order wins over the default order', () => {
  // This is how Trello `pos` reaches the lanes: the board passes its list
  // names, in pos order, as the status order.
  const items = [
    item({ locator: '1', status: 'Done', stateCategory: 'done' }),
    item({ locator: '2', status: 'Icebox', stateCategory: 'todo' }),
    item({ locator: '3', status: 'Doing', stateCategory: 'in_progress' })
  ];
  const groups = workflowStatusGroups(items, ['Done', 'Icebox', 'Doing']);
  assert.deepEqual(
    groups.map(group => group.name),
    ['Done', 'Icebox', 'Doing']
  );
});

test('sortWorkItemsByWorkflow follows the given list order first', () => {
  const items = [
    item({ locator: '1', status: 'Blocked', stateCategory: 'in_progress' }),
    item({ locator: '2', status: 'Backlog', stateCategory: 'todo' }),
    item({ locator: '3', status: 'Done', stateCategory: 'done' })
  ];
  const sorted = sortWorkItemsByWorkflow(items, ['Backlog', 'Blocked', 'Done']);
  assert.deepEqual(
    sorted.map(entry => entry.locator),
    ['2', '1', '3']
  );
});

test('workflowStatusLanes includes lists with no cards so they stay droppable', () => {
  const items = [item({ locator: '1', status: 'To Do', stateCategory: 'todo' })];
  const discovered: WorkStatusOption[] = [
    { id: 'list-todo', name: 'To Do', stateCategory: 'todo', current: false },
    { id: 'list-review', name: 'In Review', stateCategory: 'in_progress', current: false }
  ];
  const lanes = workflowStatusLanes(items, discovered, ['To Do', 'In Review']);
  assert.deepEqual(
    lanes.map(lane => lane.name),
    ['To Do', 'In Review']
  );
});

test('workflowStatusLanes keeps a card whose list is no longer on the board', () => {
  // A card can sit in an archived list; dropping its lane would hide the card.
  const items = [item({ locator: '1', status: 'Retired', stateCategory: 'todo' })];
  const discovered: WorkStatusOption[] = [
    { id: 'list-todo', name: 'To Do', stateCategory: 'todo', current: false }
  ];
  const lanes = workflowStatusLanes(items, discovered, ['To Do']);
  assert.ok(lanes.some(lane => lane.name === 'Retired'));
});

test('workflowStatusLaneKey folds casing and separators but not category', () => {
  assert.equal(workflowStatusLaneKey('To Do', 'todo'), workflowStatusLaneKey('todo', 'todo'));
  assert.equal(
    workflowStatusLaneKey('In-Progress', 'in_progress'),
    workflowStatusLaneKey('in progress', 'in_progress')
  );
  assert.notEqual(workflowStatusLaneKey('Done', 'done'), workflowStatusLaneKey('Done', 'todo'));
});

test('workflowStatusTone is stable for a known list name and derived otherwise', () => {
  assert.equal(workflowStatusTone('In Review', 'in_progress'), 'review');
  assert.equal(workflowStatusTone('Done', 'done'), 'done');
  const first = workflowStatusTone('Some Custom List', 'todo');
  const second = workflowStatusTone('Some Custom List', 'todo');
  assert.equal(first, second);
});

test('assigneeAvatarIdentity derives stable initials and a stable tone', () => {
  const identity = assigneeAvatarIdentity('Ada Lovelace');
  assert.equal(identity.initials, 'AL');
  assert.equal(assigneeAvatarIdentity('ada  lovelace').tone, identity.tone);
  assert.equal(assigneeAvatarIdentity('').initials, '?');
});

test('statusFilterOptions and assigneeFilterOptions surface an unassigned sentinel', () => {
  const items = [
    item({ locator: '1', status: 'To Do', assignee: 'Ada Lovelace' }),
    item({ locator: '2', status: 'To Do', assignee: null })
  ];
  const statuses = statusFilterOptions(items);
  assert.deepEqual(statuses.map(option => option.value), ['To Do']);

  const assignees = assigneeFilterOptions(items);
  assert.ok(assignees.some(option => option.value === UNASSIGNED_ASSIGNEE_FILTER));
  assert.ok(assignees.some(option => option.value === 'Ada Lovelace'));
});

test('labelFilterOptions surfaces a "No labels" sentinel', () => {
  const items = [
    item({ locator: '1', labels: ['bug', 'purple'] }),
    item({ locator: '2', labels: [] })
  ];
  const options = labelFilterOptions(items);
  assert.ok(options.some(option => option.value === 'bug'));
  // An unnamed Trello label reaches the board as its colour name.
  assert.ok(options.some(option => option.value === 'purple'));
  assert.ok(options.some(option => option.value === NO_LABELS_FILTER));
});

test('toggleFilterOptionSelection adds then removes a value, case-insensitively', () => {
  const withValue = toggleFilterOptionSelection([], 'Ada Lovelace');
  assert.deepEqual(withValue, ['Ada Lovelace']);
  const removed = toggleFilterOptionSelection(withValue, 'ada lovelace');
  assert.deepEqual(removed, []);
});

test('canonicalizeSelectedFilterOptions folds a selection onto the on-screen casing', () => {
  const canonical = canonicalizeSelectedFilterOptions(
    ['in review', 'in review'],
    [{ value: 'In Review', label: 'In Review' }]
  );
  assert.deepEqual(canonical, ['In Review']);
});

test('filterWorkItemsByAttributes ANDs facets and ORs values within a facet', () => {
  const items = [
    item({ locator: '1', assignee: 'Ada Lovelace', status: 'Doing', labels: ['bug'] }),
    item({ locator: '2', assignee: 'Grace Hopper', status: 'Doing', labels: [] }),
    item({ locator: '3', assignee: 'Ada Lovelace', status: 'To Do', labels: ['bug'] })
  ];
  const filtered = filterWorkItemsByAttributes(items, {
    statuses: ['Doing'],
    assignees: ['Ada Lovelace'],
    labels: []
  });
  assert.deepEqual(
    filtered.map(entry => entry.locator),
    ['1']
  );

  const eitherMember = filterWorkItemsByAttributes(items, {
    statuses: [],
    assignees: ['Ada Lovelace', 'Grace Hopper'],
    labels: []
  });
  assert.equal(eitherMember.length, 3);

  const noLabels = filterWorkItemsByAttributes(items, {
    statuses: [],
    assignees: [],
    labels: [NO_LABELS_FILTER]
  });
  assert.deepEqual(
    noLabels.map(entry => entry.locator),
    ['2']
  );

  const unassigned = filterWorkItemsByAttributes(
    [...items, item({ locator: '4', assignee: null })],
    { statuses: [], assignees: [UNASSIGNED_ASSIGNEE_FILTER], labels: [] }
  );
  assert.deepEqual(
    unassigned.map(entry => entry.locator),
    ['4']
  );
});

test('an empty filter set matches everything', () => {
  const items = [item({ locator: '1' }), item({ locator: '2' })];
  assert.equal(
    filterWorkItemsByAttributes(items, { statuses: [], assignees: [], labels: [] }).length,
    2
  );
});

test('isGroupCollapsed defaults done groups to collapsed and respects overrides and search', () => {
  assert.equal(
    isGroupCollapsed({ overrides: {}, groupKey: 'done:done', category: 'done' }),
    true
  );
  assert.equal(
    isGroupCollapsed({ overrides: {}, groupKey: 'todo:todo', category: 'todo' }),
    false
  );
  const overrides = toggleGroupCollapsedOverride({}, 'done:done', 'done');
  assert.equal(
    isGroupCollapsed({ overrides, groupKey: 'done:done', category: 'done' }),
    false
  );
  assert.equal(
    isGroupCollapsed({
      overrides,
      groupKey: 'done:done',
      category: 'done',
      searchActive: true
    }),
    false
  );
});

test('toggling a group back to its default drops the override entirely', () => {
  const collapsed = toggleGroupCollapsedOverride({}, 'todo:todo', 'todo');
  assert.deepEqual(collapsed, { 'todo:todo': true });
  assert.deepEqual(toggleGroupCollapsedOverride(collapsed, 'todo:todo', 'todo'), {});
});

test('formatAttachmentSize renders bytes, KB, and MB ranges', () => {
  assert.equal(formatAttachmentSize(0), '0 B');
  assert.equal(formatAttachmentSize(512), '512 B');
  assert.equal(formatAttachmentSize(493_568), '482 KB');
  assert.equal(formatAttachmentSize(3_250_586), '3.1 MB');
});
