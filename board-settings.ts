// Ported from the Taskboard plugin's board-settings.ts. Board settings are
// source-agnostic (they describe how a project's board is displayed, not how
// work items are fetched), so this is almost a verbatim port.
//
// Adaptations for Trello:
// - `bbProjectIdSchema` is defined here instead of imported from
//   contract.ts: contract.ts imports `projectBoardSettingsSchema` from this
//   file, so importing back from contract.ts would be a cycle. This file
//   must stay self-contained.
// - The filter field enum drops `priority` (Trello cards have no priority
//   field) and has no project/lane facet: a bb project maps to exactly one
//   Trello board, and that board's lists are already the `status` facet, so
//   a second lane dimension would filter on the same column twice.
// - `statusOrder` persists a lane order by list name. It is only a fallback:
//   once the board's real lists load, the board orders lanes by Trello's own
//   `pos` instead.
import { z } from 'zod';
import { DEFAULT_WORKFLOW_STATUS_ORDER } from './browse.js';

export { DEFAULT_WORKFLOW_STATUS_ORDER } from './browse.js';

export const bbProjectIdSchema = z.string().startsWith('proj_');

export const trackerViewSchema = z.enum(['list', 'kanban']);
export type TrackerView = z.infer<typeof trackerViewSchema>;

export const workItemFilterFieldSchema = z.enum([
  'state',
  'status',
  'assignee',
  'labels'
]);
export type WorkItemFilterField = z.infer<typeof workItemFilterFieldSchema>;

export const DEFAULT_WORK_ITEM_FILTER_FIELDS: readonly WorkItemFilterField[] = [
  'state',
  'status',
  'assignee',
  'labels'
];

function uniqueNormalizedStrings(values: readonly string[]): boolean {
  return (
    new Set(values.map(value => value.trim().toLocaleLowerCase())).size ===
    values.length
  );
}

export const projectBoardSettingsSchema = z
  .object({
    projectId: bbProjectIdSchema,
    defaultView: trackerViewSchema,
    enabledFilters: z.array(workItemFilterFieldSchema),
    statusOrder: z.array(z.string().trim().min(1).max(80)).min(1).max(50)
  })
  .strict()
  .superRefine((settings, context) => {
    if (new Set(settings.enabledFilters).size !== settings.enabledFilters.length) {
      context.addIssue({
        code: 'custom',
        path: ['enabledFilters'],
        message: 'Filter fields must be unique'
      });
    }
    if (!uniqueNormalizedStrings(settings.statusOrder)) {
      context.addIssue({
        code: 'custom',
        path: ['statusOrder'],
        message: 'Board lists must be unique'
      });
    }
  });
export type ProjectBoardSettings = z.infer<typeof projectBoardSettingsSchema>;

export function defaultProjectBoardSettings(
  projectId: string
): ProjectBoardSettings {
  return projectBoardSettingsSchema.parse({
    projectId,
    defaultView: 'list',
    enabledFilters: [...DEFAULT_WORK_ITEM_FILTER_FIELDS],
    statusOrder: [...DEFAULT_WORKFLOW_STATUS_ORDER]
  });
}
