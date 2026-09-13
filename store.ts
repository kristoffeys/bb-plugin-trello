// SQLite cache for Trello cards, keyed by bb project.
//
// Ported from the Taskboard plugin's store, minus its multi-source dimension:
// this plugin has one provider, so (bb_project_id, locator) is the item key and
// there is no `source` column anywhere.
import { randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import {
  FILTER_PRESET_LIMIT,
  defaultProjectBoardSettings,
  filterPresetIdSchema,
  filterPresetNameSchema,
  filterPresetOrderSchema,
  filterPresetProjectIdSchema,
  filterPresetSchema,
  filterPresetStateSchema,
  listCategoriesSchema,
  projectBoardSettingsSchema,
  projectScopeSchema,
  workItemSchema,
  type BoardStatus,
  type FilterPreset,
  type ProjectBoardSettings,
  type ProjectScope,
  type WorkItem,
  type WorkStateCategory
} from './contract.js';
import {
  normalizePresetName,
  resolvePresetOrder,
  serializeFilterPresetState
} from './filter-presets.js';

type PluginDatabase = ReturnType<BbPluginApi['storage']['database']>;
type SqlParameter = string | number | null;

interface WorkItemRow {
  bb_project_id: string;
  locator: string;
  item_key: string;
  title: string;
  description: string;
  url: string;
  status: string;
  status_id: string;
  state_category: string;
  assignee: string | null;
  assignee_id: string | null;
  board: string | null;
  board_id: string | null;
  labels_json: string;
  due_date: string | null;
  updated_at: string;
}

interface SyncRow {
  last_synced_at: string | null;
  error: string | null;
  notice: string | null;
  item_count: number;
}

interface ProjectScopeRow {
  bb_project_id: string;
  board_id: string;
  assigned_to_me_only: number;
  include_closed: number;
  list_categories_json: string;
}

interface BoardSettingsRow {
  bb_project_id: string;
  default_view: string;
  enabled_filters_json: string;
  status_order_json: string;
}

interface FilterPresetRow {
  id: string;
  bb_project_id: string;
  name: string;
  name_normalized: string;
  filters_json: string;
  position: number;
}

export interface WorkItemFilters {
  /** Omit to search every project cache. */
  projectId?: string;
  query?: string;
  stateCategories?: WorkStateCategory[];
  limit: number;
}

export type ProjectScopeDefaults = Omit<ProjectScope, 'projectId'>;

function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string): string[] {
  const parsed = parseJsonSafely(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, character => `\\${character}`);
}

/** Returns null for a row we cannot make sense of, so one bad row never
 *  breaks a whole list read. */
function itemFromRow(row: WorkItemRow): WorkItem | null {
  const parsed = workItemSchema.safeParse({
    bbProjectId: row.bb_project_id,
    locator: row.locator,
    key: row.item_key,
    title: row.title,
    description: row.description,
    url: row.url,
    status: row.status,
    statusId: row.status_id,
    stateCategory: row.state_category,
    assignee: row.assignee,
    assigneeId: row.assignee_id,
    board: row.board,
    boardId: row.board_id,
    labels: parseStringArray(row.labels_json),
    dueDate: row.due_date,
    updatedAt: row.updated_at
  });
  return parsed.success ? parsed.data : null;
}

function scopeFromRow(row: ProjectScopeRow): ProjectScope {
  // A per-list override map that no longer parses is dropped rather than
  // blocking the scope read: the name heuristic is always a usable fallback.
  const parsedCategories = listCategoriesSchema.safeParse(
    parseJsonSafely(row.list_categories_json) ?? {}
  );
  return projectScopeSchema.parse({
    projectId: row.bb_project_id,
    boardId: row.board_id,
    assignedToMeOnly: row.assigned_to_me_only === 1,
    includeClosed: row.include_closed === 1,
    listCategories: parsedCategories.success ? parsedCategories.data : {}
  });
}

function boardSettingsFromRow(row: BoardSettingsRow): ProjectBoardSettings {
  const defaults = defaultProjectBoardSettings(row.bb_project_id);
  const parsed = projectBoardSettingsSchema.safeParse({
    projectId: row.bb_project_id,
    defaultView: row.default_view,
    enabledFilters: parseJsonSafely(row.enabled_filters_json) ??
      defaults.enabledFilters,
    statusOrder: parseJsonSafely(row.status_order_json) ?? defaults.statusOrder
  });
  return parsed.success ? parsed.data : defaults;
}

function filterPresetFromRow(row: FilterPresetRow): FilterPreset | null {
  const state = parseJsonSafely(row.filters_json);
  if (state === undefined) return null;
  const parsed = filterPresetSchema.safeParse({
    id: row.id,
    projectId: row.bb_project_id,
    name: row.name,
    state,
    position: row.position
  });
  return parsed.success ? parsed.data : null;
}

export function createWorkItemStore(bb: BbPluginApi) {
  const db: PluginDatabase = bb.storage.database();
  bb.storage.migrate(db, [
    `
      CREATE TABLE work_items (
        bb_project_id TEXT NOT NULL,
        locator TEXT NOT NULL,
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        status_id TEXT NOT NULL,
        state_category TEXT NOT NULL CHECK (
          state_category IN ('todo', 'in_progress', 'done')
        ),
        assignee TEXT,
        assignee_id TEXT,
        board TEXT,
        board_id TEXT,
        labels_json TEXT NOT NULL,
        due_date TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bb_project_id, locator)
      );

      CREATE INDEX idx_work_items_project
        ON work_items(bb_project_id, updated_at DESC, locator);

      CREATE TABLE project_sync (
        bb_project_id TEXT PRIMARY KEY,
        last_synced_at TEXT,
        error TEXT,
        item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0)
      );

      CREATE TABLE project_scope (
        bb_project_id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        assigned_to_me_only INTEGER NOT NULL CHECK (
          assigned_to_me_only IN (0, 1)
        ),
        include_closed INTEGER NOT NULL CHECK (include_closed IN (0, 1)),
        list_categories_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_board_settings (
        bb_project_id TEXT PRIMARY KEY,
        default_view TEXT NOT NULL,
        enabled_filters_json TEXT NOT NULL,
        status_order_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_board_view (
        bb_project_id TEXT PRIMARY KEY,
        view_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_filter_presets (
        id TEXT NOT NULL PRIMARY KEY
          CHECK (length(id) BETWEEN 1 AND 100),
        bb_project_id TEXT NOT NULL
          CHECK (
            substr(bb_project_id, 1, 5) = 'proj_' AND
            length(bb_project_id) BETWEEN 6 AND 500
          ),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        name_normalized TEXT NOT NULL
          CHECK (length(name_normalized) BETWEEN 1 AND 240),
        filters_json TEXT NOT NULL
          CHECK (length(CAST(filters_json AS BLOB)) BETWEEN 1 AND 910000),
        position INTEGER NOT NULL CHECK (position >= 0 AND position < 50),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (bb_project_id, name_normalized)
      );

      CREATE INDEX idx_filter_presets_project
        ON project_filter_presets(bb_project_id, position, created_at, id);
    `,
    // A successful sync that could not show everything: not an error, but the
    // user still has to be told.
    `ALTER TABLE project_sync ADD COLUMN notice TEXT;`
  ]);

  const upsertItem = db.prepare<
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
      string | null,
      string
    ]
  >(`
    INSERT INTO work_items (
      bb_project_id, locator, item_key, title, description, url, status,
      status_id, state_category, assignee, assignee_id, board, board_id,
      labels_json, due_date, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bb_project_id, locator) DO UPDATE SET
      item_key = excluded.item_key,
      title = excluded.title,
      description = excluded.description,
      url = excluded.url,
      status = excluded.status,
      status_id = excluded.status_id,
      state_category = excluded.state_category,
      assignee = excluded.assignee,
      assignee_id = excluded.assignee_id,
      board = excluded.board,
      board_id = excluded.board_id,
      labels_json = excluded.labels_json,
      due_date = excluded.due_date,
      updated_at = excluded.updated_at
  `);

  /** Returns false for an item we cannot make sense of, so one bad card never
   *  breaks a whole sync — the mirror of `itemFromRow` on the read path. */
  function writeItem(item: WorkItem): boolean {
    const result = workItemSchema.safeParse(item);
    if (!result.success) return false;
    const parsed = result.data;
    upsertItem.run(
      parsed.bbProjectId,
      parsed.locator,
      parsed.key,
      parsed.title,
      parsed.description,
      parsed.url,
      parsed.status,
      parsed.statusId,
      parsed.stateCategory,
      parsed.assignee,
      parsed.assigneeId,
      parsed.board,
      parsed.boardId,
      JSON.stringify(parsed.labels),
      parsed.dueDate,
      parsed.updatedAt
    );
    return true;
  }

  const deleteProjectItems = db.prepare<[string]>(
    'DELETE FROM work_items WHERE bb_project_id = ?'
  );
  const writeSync = db.prepare<[string, string, string | null, number]>(`
    INSERT INTO project_sync (
      bb_project_id, last_synced_at, error, notice, item_count
    )
    VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(bb_project_id) DO UPDATE SET
      last_synced_at = excluded.last_synced_at,
      error = NULL,
      notice = excluded.notice,
      item_count = excluded.item_count
  `);

  const replaceAllTransaction = db.transaction(
    (projectId: string, items: WorkItem[], syncedAt: string, notice: string | null) => {
      deleteProjectItems.run(projectId);
      let written = 0;
      for (const item of items) {
        if (writeItem(item)) written += 1;
      }
      writeSync.run(projectId, syncedAt, notice, written);
      return items.length - written;
    }
  );

  const readScope = db.prepare<[string], ProjectScopeRow>(`
    SELECT bb_project_id, board_id, assigned_to_me_only, include_closed,
           list_categories_json
    FROM project_scope
    WHERE bb_project_id = ?
  `);

  const readBoardSettings = db.prepare<[string], BoardSettingsRow>(`
    SELECT bb_project_id, default_view, enabled_filters_json, status_order_json
    FROM project_board_settings
    WHERE bb_project_id = ?
  `);

  const readPresets = db.prepare<[string], FilterPresetRow>(`
    SELECT id, bb_project_id, name, name_normalized, filters_json, position
    FROM project_filter_presets
    WHERE bb_project_id = ?
    ORDER BY position ASC, created_at ASC, id ASC
    LIMIT ${FILTER_PRESET_LIMIT + 1}
  `);

  const readPreset = db.prepare<[string, string], FilterPresetRow>(`
    SELECT id, bb_project_id, name, name_normalized, filters_json, position
    FROM project_filter_presets
    WHERE bb_project_id = ? AND id = ?
  `);

  const updatePresetPosition = db.prepare<[number, string, string, string]>(`
    UPDATE project_filter_presets
    SET position = ?, updated_at = ?
    WHERE bb_project_id = ? AND id = ?
  `);

  function visiblePresets(projectId: string): FilterPreset[] {
    return readPresets
      .all(projectId)
      .map(filterPresetFromRow)
      .filter((preset): preset is FilterPreset => preset !== null)
      .slice(0, FILTER_PRESET_LIMIT);
  }

  return {
    list(filters: WorkItemFilters): WorkItem[] {
      const query = filters.query?.trim() ?? '';
      const states = filters.stateCategories ?? [];
      const parameters: Record<string, SqlParameter> = {
        projectId: filters.projectId ?? null,
        query: query ? `%${escapeLike(query)}%` : '',
        states: JSON.stringify(states),
        stateCount: states.length,
        limit: filters.limit
      };
      return db
        .prepare<Record<string, SqlParameter>, WorkItemRow>(
          `
          SELECT *
          FROM work_items AS item
          WHERE (:projectId IS NULL OR item.bb_project_id = :projectId)
            AND (
              :query = '' OR
              item.item_key LIKE :query ESCAPE '\\' COLLATE NOCASE OR
              item.title LIKE :query ESCAPE '\\' COLLATE NOCASE OR
              item.description LIKE :query ESCAPE '\\' COLLATE NOCASE OR
              item.status LIKE :query ESCAPE '\\' COLLATE NOCASE OR
              item.board LIKE :query ESCAPE '\\' COLLATE NOCASE
            )
            AND (
              :stateCount = 0 OR
              item.state_category IN (SELECT value FROM json_each(:states))
            )
          ORDER BY item.updated_at DESC, item.bb_project_id, item.locator
          LIMIT :limit
        `
        )
        .all(parameters)
        .map(itemFromRow)
        .filter((item): item is WorkItem => item !== null);
    },

    get(projectId: string, locator: string): WorkItem | null {
      const row = db
        .prepare<[string, string], WorkItemRow>(
          'SELECT * FROM work_items WHERE bb_project_id = ? AND locator = ?'
        )
        .get(projectId, locator);
      return row ? itemFromRow(row) : null;
    },

    /** Replaces the whole cached set for one bb project in one transaction. */
    replaceAll(
      projectId: string,
      items: WorkItem[],
      syncedAt: string,
      notice: string | null = null
    ): void {
      for (const item of items) {
        if (item.bbProjectId !== projectId) {
          throw new Error('Cannot write a work item outside its BB project');
        }
      }
      const skipped = replaceAllTransaction(projectId, items, syncedAt, notice);
      if (skipped > 0) {
        bb.log.warn(
          `skipped ${skipped} unreadable card(s) while syncing ${projectId}`
        );
      }
    },

    upsert(projectId: string, item: WorkItem): void {
      if (item.bbProjectId !== projectId) {
        throw new Error('Cannot write a work item outside its BB project');
      }
      if (!writeItem(item)) {
        throw new Error(`Cannot write unreadable work item ${item.locator}`);
      }
    },

    setSyncError(projectId: string, message: string): void {
      db.transaction(() => {
        const count =
          db
            .prepare<[string], { count: number }>(
              'SELECT COUNT(*) AS count FROM work_items WHERE bb_project_id = ?'
            )
            .get(projectId)?.count ?? 0;
        db.prepare<[string, string, number]>(
          `
          INSERT INTO project_sync (
            bb_project_id, last_synced_at, error, notice, item_count
          ) VALUES (?, NULL, ?, NULL, ?)
          ON CONFLICT(bb_project_id) DO UPDATE SET
            error = excluded.error,
            notice = NULL,
            item_count = excluded.item_count
        `
        ).run(projectId, message, count);
      })();
    },

    syncStatus(projectId: string): BoardStatus {
      const row = db
        .prepare<[string], SyncRow>(
          `SELECT last_synced_at, error, notice, item_count
           FROM project_sync WHERE bb_project_id = ?`
        )
        .get(projectId);
      const scope = readScope.get(projectId);
      return {
        configured: (scope?.board_id ?? '') !== '',
        available: (row?.error ?? null) === null,
        // A notice rides the same field as an error, but leaves the board
        // available: the sync worked, it just could not show everything.
        message: row?.error ?? row?.notice ?? null,
        lastSyncedAt: row?.last_synced_at ?? null,
        itemCount: row?.item_count ?? 0
      };
    },

    projectScope(projectId: string, defaults: ProjectScopeDefaults): ProjectScope {
      const row = readScope.get(projectId);
      return row
        ? scopeFromRow(row)
        : projectScopeSchema.parse({ projectId, ...defaults });
    },

    saveProjectScope(input: ProjectScope): ProjectScope {
      const scope = projectScopeSchema.parse(input);
      return db.transaction(() => {
        const previous = readScope.get(scope.projectId);
        db.prepare<[string, string, number, number, string, string]>(
          `
          INSERT INTO project_scope (
            bb_project_id, board_id, assigned_to_me_only, include_closed,
            list_categories_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(bb_project_id) DO UPDATE SET
            board_id = excluded.board_id,
            assigned_to_me_only = excluded.assigned_to_me_only,
            include_closed = excluded.include_closed,
            list_categories_json = excluded.list_categories_json,
            updated_at = excluded.updated_at
        `
        ).run(
          scope.projectId,
          scope.boardId,
          scope.assignedToMeOnly ? 1 : 0,
          scope.includeClosed ? 1 : 0,
          JSON.stringify(scope.listCategories),
          new Date().toISOString()
        );
        // Retargeting the board invalidates every cached row.
        const retargeted =
          previous !== undefined && previous.board_id !== scope.boardId;
        if (retargeted) {
          deleteProjectItems.run(scope.projectId);
          db.prepare<[string]>(
            'DELETE FROM project_sync WHERE bb_project_id = ?'
          ).run(scope.projectId);
        }
        return scopeFromRow(readScope.get(scope.projectId)!);
      })();
    },

    /**
     * The board's last-used filters and layout. Stored as opaque JSON: the
     * shape is owned by contract.ts, and a row that no longer parses is simply
     * ignored by the caller rather than blocking the board from opening.
     */
    readBoardView(projectId: string): unknown | null {
      const row = db
        .prepare(
          'SELECT view_json FROM project_board_view WHERE bb_project_id = ?'
        )
        .get(projectId) as { view_json: string } | undefined;
      if (row === undefined) return null;
      try {
        return JSON.parse(row.view_json) as unknown;
      } catch {
        return null;
      }
    },

    writeBoardView(projectId: string, view: unknown): void {
      db.prepare(
        `INSERT INTO project_board_view (bb_project_id, view_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(bb_project_id) DO UPDATE SET
           view_json = excluded.view_json,
           updated_at = excluded.updated_at`
      ).run(projectId, JSON.stringify(view), new Date().toISOString());
    },

    boardSettings(projectId: string): ProjectBoardSettings {
      const row = readBoardSettings.get(projectId);
      return row
        ? boardSettingsFromRow(row)
        : defaultProjectBoardSettings(projectId);
    },

    saveBoardSettings(input: ProjectBoardSettings): ProjectBoardSettings {
      const settings = projectBoardSettingsSchema.parse(input);
      db.prepare<[string, string, string, string, string]>(
        `
        INSERT INTO project_board_settings (
          bb_project_id, default_view, enabled_filters_json, status_order_json,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(bb_project_id) DO UPDATE SET
          default_view = excluded.default_view,
          enabled_filters_json = excluded.enabled_filters_json,
          status_order_json = excluded.status_order_json,
          updated_at = excluded.updated_at
      `
      ).run(
        settings.projectId,
        settings.defaultView,
        JSON.stringify(settings.enabledFilters),
        JSON.stringify(settings.statusOrder),
        new Date().toISOString()
      );
      return boardSettingsFromRow(readBoardSettings.get(settings.projectId)!);
    },

    listPresets(projectId: string): FilterPreset[] {
      return visiblePresets(filterPresetProjectIdSchema.parse(projectId));
    },

    savePreset(input: {
      projectId: string;
      id?: string;
      name: string;
      state: FilterPreset['state'];
    }): FilterPreset {
      const projectId = filterPresetProjectIdSchema.parse(input.projectId);
      const id = input.id ? filterPresetIdSchema.parse(input.id) : undefined;
      const name = filterPresetNameSchema.parse(input.name);
      const normalized = normalizePresetName(name);
      const serializedState = serializeFilterPresetState(
        filterPresetStateSchema.parse(input.state)
      );
      const now = new Date().toISOString();

      function readSaved(presetId: string): FilterPreset {
        const row = readPreset.get(projectId, presetId);
        const saved = row ? filterPresetFromRow(row) : null;
        if (!saved) throw new Error('Saved filter preset could not be read back');
        return saved;
      }

      return db.transaction(() => {
        const conflict = db
          .prepare<[string, string], { id: string; name: string }>(
            `SELECT id, name FROM project_filter_presets
             WHERE bb_project_id = ? AND name_normalized = ?`
          )
          .get(projectId, normalized);
        if (conflict && conflict.id !== id) {
          throw new Error(`A filter preset named "${conflict.name}" already exists`);
        }

        if (id) {
          if (!readPreset.get(projectId, id)) {
            throw new Error(`Unknown filter preset: ${id}`);
          }
          db.prepare<[string, string, string, string, string, string]>(
            `UPDATE project_filter_presets
             SET name = ?, name_normalized = ?, filters_json = ?, updated_at = ?
             WHERE bb_project_id = ? AND id = ?`
          ).run(name, normalized, serializedState, now, projectId, id);
          return readSaved(id);
        }

        const rows = readPresets.all(projectId);
        if (rows.length >= FILTER_PRESET_LIMIT) {
          throw new Error(
            `A project can have at most ${FILTER_PRESET_LIMIT} filter presets`
          );
        }
        // Close any gaps left by earlier deletes before appending.
        rows.forEach((row, index) => {
          if (row.position === index) return;
          updatePresetPosition.run(index, now, projectId, row.id);
        });

        const newId = filterPresetIdSchema.parse(
          `fp_${randomUUID().replaceAll('-', '')}`
        );
        db.prepare<
          [string, string, string, string, string, number, string, string]
        >(
          `INSERT INTO project_filter_presets (
             id, bb_project_id, name, name_normalized, filters_json, position,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          newId,
          projectId,
          name,
          normalized,
          serializedState,
          rows.length,
          now,
          now
        );
        return readSaved(newId);
      })();
    },

    // Deleting an unknown id is a deliberate no-op: delete is idempotent and
    // callers resync from the returned list.
    deletePreset(projectId: string, id: string): FilterPreset[] {
      const parsedProjectId = filterPresetProjectIdSchema.parse(projectId);
      const parsedId = filterPresetIdSchema.parse(id);
      return db.transaction(() => {
        const deletion = db
          .prepare<[string, string]>(
            'DELETE FROM project_filter_presets WHERE bb_project_id = ? AND id = ?'
          )
          .run(parsedProjectId, parsedId);
        if (deletion.changes === 0) return visiblePresets(parsedProjectId);
        // Renumber every remaining row, including unreadable ones: they are
        // invisible to clients but still occupy a position.
        const remaining = readPresets.all(parsedProjectId);
        if (remaining.length > FILTER_PRESET_LIMIT) {
          return visiblePresets(parsedProjectId);
        }
        const now = new Date().toISOString();
        remaining.forEach((row, index) => {
          if (row.position === index) return;
          updatePresetPosition.run(index, now, parsedProjectId, row.id);
        });
        return visiblePresets(parsedProjectId);
      })();
    },

    reorderPresets(projectId: string, ids: readonly string[]): FilterPreset[] {
      const parsedProjectId = filterPresetProjectIdSchema.parse(projectId);
      const parsedIds = filterPresetOrderSchema.parse(ids);
      return db.transaction(() => {
        const rows = readPresets.all(parsedProjectId);
        if (rows.length > FILTER_PRESET_LIMIT) {
          throw new Error('Stored filter preset limit exceeded');
        }
        // Validate against the parseable subset only, otherwise one corrupt
        // row would block every reorder for this project forever.
        const currentIds = rows
          .filter(row => filterPresetFromRow(row) !== null)
          .map(row => row.id);
        const ordered = resolvePresetOrder(currentIds, parsedIds);
        const positionById = new Map(rows.map(row => [row.id, row.position]));
        const now = new Date().toISOString();
        ordered.forEach((id, index) => {
          if (positionById.get(id) === index) return;
          updatePresetPosition.run(index, now, parsedProjectId, id);
        });
        return visiblePresets(parsedProjectId);
      })();
    },

    /** BB projects mapped to a Trello board — what the sync loop walks. */
    configuredProjectIds(): string[] {
      return db
        .prepare<[], { bb_project_id: string }>(
          `SELECT bb_project_id FROM project_scope
           WHERE board_id <> ''
           ORDER BY bb_project_id`
        )
        .all()
        .map(row => row.bb_project_id);
    }
  };
}

export type WorkItemStore = ReturnType<typeof createWorkItemStore>;
