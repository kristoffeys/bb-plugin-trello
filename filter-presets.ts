// Ported from the Taskboard plugin's filter-presets.ts. Filter presets are a
// source-agnostic feature (a named, ordered, persisted filter snapshot), so
// the id/name/order/limit machinery here is a verbatim port.
//
// Adaptations for Trello:
// - `filterPresetProjectIdSchema` no longer imports `bbProjectIdSchema` from
//   a shared credential-contract module (contract.ts owns that schema here,
//   and importing from contract.ts would be a cycle since contract.ts
//   imports from this file). It is redefined locally instead.
// - Taskboard's preset state was a full multi-source `BrowsePreferences`
//   snapshot (provider/source + priorities + externalProjects), ported from
//   browse-preferences.ts. This plugin has exactly one provider (Trello) and
//   is scoped to a single bb project, so that whole multi-source preference
//   store has no equivalent here. `filterPresetStateSchema` is defined
//   locally instead, matching the trimmed filter field set from
//   board-settings.ts: no `provider`/`source`/`priorities`, and no lane
//   facet — a Trello board's lists are the `statuses` facet.
import { z } from 'zod';
import type { TrackerView } from './board-settings.js';

export const FILTER_PRESET_NAME_MAX_LENGTH = 60;
export const FILTER_PRESET_NORMALIZED_NAME_MAX_LENGTH = 240;
export const FILTER_PRESET_ID_MAX_LENGTH = 100;
export const FILTER_PRESET_PROJECT_ID_MAX_LENGTH = 500;
export const FILTER_PRESET_LIMIT = 50;
export const FILTER_PRESET_STATE_JSON_MAX_LENGTH = 910_000;
export const FILTER_PRESET_PROJECT_STATE_BYTES_MAX = 950_000;

const FILTER_PRESET_VALUE_LIMIT = 100;
const FILTER_PRESET_COLLAPSED_GROUP_LIMIT = 100;
const FILTER_PRESET_VALUE_MAX_LENGTH = 500;
const FILTER_PRESET_QUERY_MAX_LENGTH = 500;
const FILTER_PRESET_STATE_CATEGORY_LIMIT = 3;
const FILTER_PRESET_TOP_LEVEL_KEYS = new Set([
  'version',
  'view',
  'query',
  'stateCategories',
  'statuses',
  'assignees',
  'labels',
  'collapsedGroups'
]);

const FILTER_PRESET_STATE_VERSION = 1 as const;

const unsafeControlCharacters =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function hasUnsafeControlCharacters(value: string): boolean {
  return unsafeControlCharacters.test(value);
}

export const filterPresetProjectIdSchema = z
  .string()
  .startsWith('proj_')
  .min(6)
  .max(FILTER_PRESET_PROJECT_ID_MAX_LENGTH)
  .refine(
    value =>
      value.length > FILTER_PRESET_PROJECT_ID_MAX_LENGTH ||
      !hasUnsafeControlCharacters(value),
    {
    message: 'Project id cannot contain control characters'
    }
  );

export const filterPresetIdSchema = z
  .string()
  .superRefine((value, context) => {
    if (value.length > FILTER_PRESET_ID_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `Preset id must contain at most ${FILTER_PRESET_ID_MAX_LENGTH} characters`
      });
      return;
    }
    if (hasUnsafeControlCharacters(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Preset id cannot contain control characters'
      });
    }
  })
  .trim()
  .min(1)
  .max(FILTER_PRESET_ID_MAX_LENGTH);

export const filterPresetNameSchema = z
  .string()
  .superRefine((value, context) => {
    if (value.length > FILTER_PRESET_NAME_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `Preset name must contain at most ${FILTER_PRESET_NAME_MAX_LENGTH} characters`
      });
      return;
    }
    if (hasUnsafeControlCharacters(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Preset name cannot contain control characters'
      });
    }
  })
  .trim()
  .min(1)
  .max(FILTER_PRESET_NAME_MAX_LENGTH);

function inspectBoundedString(
  value: unknown,
  maxLength: number,
  path: Array<string | number>,
  context: z.core.$RefinementCtx<unknown>
): void {
  if (typeof value !== 'string') return;
  if (value.length > maxLength) {
    context.addIssue({
      code: 'custom',
      path,
      message: `String must contain at most ${maxLength} characters`
    });
    return;
  }
  if (hasUnsafeControlCharacters(value)) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Preset state cannot contain control characters'
    });
  }
}

function ownDataValue(
  object: Record<string, unknown>,
  key: string,
  context: z.core.$RefinementCtx<unknown>
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) {
    context.addIssue({
      code: 'custom',
      path: [key],
      message: 'Preset state must contain plain data properties'
    });
    return undefined;
  }
  return descriptor.value;
}

function inspectBoundedStringArray(
  object: Record<string, unknown>,
  key: string,
  maxItems: number,
  context: z.core.$RefinementCtx<unknown>
): void {
  const value = ownDataValue(object, key, context);
  if (!Array.isArray(value)) return;
  if (value.length > maxItems) {
    context.addIssue({
      code: 'custom',
      path: [key],
      message: `Array must contain at most ${maxItems} values`
    });
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor && !('value' in descriptor)) {
      context.addIssue({
        code: 'custom',
        path: [key, index],
        message: 'Preset state must contain plain data properties'
      });
      continue;
    }
    inspectBoundedString(
      descriptor?.value,
      FILTER_PRESET_VALUE_MAX_LENGTH,
      [key, index],
      context
    );
  }
}

const controlFreePresetStateInputSchema = z.unknown().superRefine(
  (input, context) => {
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input)
    ) {
      return;
    }
    const record = input as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Preset state must be a plain object'
      });
      return;
    }
    let topLevelKeyCount = 0;
    for (const key in record) {
      topLevelKeyCount += 1;
      if (
        topLevelKeyCount > FILTER_PRESET_TOP_LEVEL_KEYS.size ||
        !Object.hasOwn(record, key) ||
        !FILTER_PRESET_TOP_LEVEL_KEYS.has(key)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Preset state contains unknown or inherited fields'
        });
        return;
      }
    }

    ownDataValue(record, 'version', context);
    inspectBoundedString(
      ownDataValue(record, 'view', context),
      10,
      ['view'],
      context
    );
    inspectBoundedString(
      ownDataValue(record, 'query', context),
      FILTER_PRESET_QUERY_MAX_LENGTH,
      ['query'],
      context
    );
    inspectBoundedStringArray(
      record,
      'stateCategories',
      FILTER_PRESET_STATE_CATEGORY_LIMIT,
      context
    );
    for (const key of ['statuses', 'assignees', 'labels']) {
      inspectBoundedStringArray(
        record,
        key,
        FILTER_PRESET_VALUE_LIMIT,
        context
      );
    }

    const collapsedGroups = ownDataValue(
      record,
      'collapsedGroups',
      context
    );
    if (
      typeof collapsedGroups === 'object' &&
      collapsedGroups !== null &&
      !Array.isArray(collapsedGroups)
    ) {
      const prototype = Object.getPrototypeOf(collapsedGroups);
      if (prototype !== Object.prototype && prototype !== null) {
        context.addIssue({
          code: 'custom',
          path: ['collapsedGroups'],
          message: 'Collapse overrides must be a plain object'
        });
        return;
      }
      let groupCount = 0;
      for (const key in collapsedGroups) {
        groupCount += 1;
        if (
          groupCount > FILTER_PRESET_COLLAPSED_GROUP_LIMIT ||
          !Object.hasOwn(collapsedGroups, key)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['collapsedGroups'],
            message: `At most ${FILTER_PRESET_COLLAPSED_GROUP_LIMIT} collapse overrides are allowed`
          });
          return;
        }
        inspectBoundedString(
          key,
          FILTER_PRESET_VALUE_MAX_LENGTH,
          ['collapsedGroups', key],
          context
        );
        const descriptor = Object.getOwnPropertyDescriptor(
          collapsedGroups,
          key
        );
        if (descriptor && !('value' in descriptor)) {
          context.addIssue({
            code: 'custom',
            path: ['collapsedGroups', key],
            message: 'Preset state must contain plain data properties'
          });
        }
      }
    }
  }
);

const boundedValueSchema = z.string().trim().min(1).max(
  FILTER_PRESET_VALUE_MAX_LENGTH
);
const uniqueValuesSchema = z
  .array(boundedValueSchema)
  .max(FILTER_PRESET_VALUE_LIMIT)
  .transform(values => [...new Set(values)]);
const collapseOverridesSchema = z
  .record(boundedValueSchema, z.boolean())
  .superRefine((overrides, context) => {
    if (Object.keys(overrides).length > FILTER_PRESET_COLLAPSED_GROUP_LIMIT) {
      context.addIssue({
        code: 'custom',
        message: `At most ${FILTER_PRESET_COLLAPSED_GROUP_LIMIT} collapse overrides are allowed`
      });
    }
  });

const filterPresetStateShapeSchema = z
  .object({
    version: z.literal(FILTER_PRESET_STATE_VERSION),
    view: z.enum(['list', 'kanban']) satisfies z.ZodType<TrackerView>,
    query: z.string().max(FILTER_PRESET_QUERY_MAX_LENGTH).default(''),
    stateCategories: z
      .array(z.enum(['todo', 'in_progress', 'done']))
      .max(FILTER_PRESET_STATE_CATEGORY_LIMIT)
      .transform(values => [...new Set(values)]),
    statuses: uniqueValuesSchema,
    assignees: uniqueValuesSchema,
    labels: uniqueValuesSchema,
    collapsedGroups: collapseOverridesSchema
  })
  .strict();

export type FilterPresetState = z.infer<typeof filterPresetStateShapeSchema>;

export const filterPresetStateSchema = controlFreePresetStateInputSchema.pipe(
  filterPresetStateShapeSchema
);

export const filterPresetSchema = z
  .object({
    id: filterPresetIdSchema,
    projectId: filterPresetProjectIdSchema,
    name: filterPresetNameSchema,
    state: filterPresetStateSchema,
    position: z.number().int().min(0).max(FILTER_PRESET_LIMIT - 1)
  })
  .strict();
export type FilterPreset = z.infer<typeof filterPresetSchema>;

export const filterPresetSummarySchema = filterPresetSchema
  .pick({
    id: true,
    projectId: true,
    name: true,
    position: true
  })
  .strict();
export type FilterPresetSummary = z.infer<typeof filterPresetSummarySchema>;

export function filterPresetSummary(
  preset: FilterPreset
): FilterPresetSummary {
  return filterPresetSummarySchema.parse({
    id: preset.id,
    projectId: preset.projectId,
    name: preset.name,
    position: preset.position
  });
}

const filterPresetOrderInputSchema = z.unknown().superRefine(
  (input, context) => {
    if (Array.isArray(input) && input.length > FILTER_PRESET_LIMIT) {
      context.addIssue({
        code: 'custom',
        message: `Preset order must contain at most ${FILTER_PRESET_LIMIT} ids`
      });
    }
  }
);

export const filterPresetOrderSchema = filterPresetOrderInputSchema.pipe(
  z.array(filterPresetIdSchema).max(FILTER_PRESET_LIMIT)
);

/**
 * Persisted uniqueness must not vary with the host locale. NFKC also makes
 * compatibility-equivalent spellings (for example full-width letters)
 * collide instead of creating visually duplicate preset names.
 */
export function normalizePresetName(name: string): string {
  const normalized = filterPresetNameSchema
    .parse(name)
    .normalize('NFKC')
    .toLowerCase();
  if (normalized.length > FILTER_PRESET_NORMALIZED_NAME_MAX_LENGTH) {
    throw new Error('Normalized filter preset name is too long');
  }
  return normalized;
}

/**
 * A reorder must be an exact permutation of the visible, parseable preset
 * ids. Anything else means the client is stale, so reject rather than guess.
 */
export function resolvePresetOrder(
  currentIds: readonly string[],
  requestedIds: readonly string[]
): string[] {
  const currentValues = filterPresetOrderSchema.parse(currentIds);
  const requestedValues = filterPresetOrderSchema.parse(requestedIds);
  if (requestedValues.length !== currentValues.length) {
    throw new Error('Preset order must list every preset exactly once');
  }
  const current = new Set(currentValues);
  if (current.size !== currentValues.length) {
    throw new Error('Stored preset order contains duplicate ids');
  }
  const seen = new Set<string>();
  for (const id of requestedValues) {
    if (!current.has(id)) throw new Error(`Unknown filter preset: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate filter preset: ${id}`);
    seen.add(id);
  }
  return [...requestedValues];
}

export function serializeFilterPresetState(
  state: FilterPresetState
): string {
  const serialized = JSON.stringify(filterPresetStateSchema.parse(state));
  if (
    new TextEncoder().encode(serialized).byteLength >
    FILTER_PRESET_STATE_JSON_MAX_LENGTH
  ) {
    throw new Error('Filter preset state is too large');
  }
  return serialized;
}
