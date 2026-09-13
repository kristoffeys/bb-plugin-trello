// Shared, source-agnostic helpers ported from the Taskboard plugin's
// browse.ts. Only the pieces board-settings.ts needs are kept here — the
// rest of that file (592 lines) is Linear/GitHub/Jira browsing logic that
// has no Trello equivalent and lives in trello/ instead.

/**
 * Fallback lane order used before a board's real lists are known. A Trello
 * board's lists are named by whoever made the board, so there is no universal
 * name list to port from Taskboard — these three are just a generic label per
 * state category, good enough until `listLists` returns the board's actual
 * columns (which the board then orders by Trello's own `pos`).
 */
export const DEFAULT_WORKFLOW_STATUS_ORDER: readonly string[] = [
  'To Do',
  'Doing',
  'Done'
];
