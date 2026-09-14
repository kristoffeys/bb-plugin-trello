// bb-plugin-trello — frontend entry.
//
// A near-clone of the Taskboard plugin's board UI, trimmed to one provider
// (Trello) and one credential pair (an API key plus a user token). There is no
// source switching, no priority field, and every bb project maps to exactly
// one Trello board (board-settings.ts, contract.ts, server.ts already encode
// that). board-view.ts (pure helpers: grouping, lanes, filter options,
// collapse state) is reused as-is; this file is the React layer on top of it.
//
// Kanban lanes are always the board's Trello lists, in Trello's own `pos`
// order — there is no lane-grouping choice to make, because a Trello list is
// simultaneously the card's status and the board's column.
//
// ponytail: the Taskboard template also ships a resizable, auto-collapsing
// sidebar and a two-mode (full/constrained) filter bar. Both are dropped
// here for a single fixed-width sidebar and a single filter-dropdown layout
// that works at any width — a few hundred lines saved for a UI difference
// only visible at extreme window widths. Add the constrained mode back if a
// narrow host surface (e.g. the thread side panel) turns out to need it.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';
import {
  Markdown,
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginNavPanelProps,
  type PluginNewThreadPanelProps,
  type PluginPendingInteractionProps,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps
} from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icon, type IconName } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  CONNECTION_CHANGED,
  ITEMS_CHANGED,
  PRESETS_CHANGED,
  connectionInteractionPayloadSchema,
  connectionInteractionResponseSchema,
  type ConnectionMutation,
  type ConnectionView,
  type CreateTaskContext,
  type CreateTaskInput,
  type CreateTaskMetadata,
  type CreateTaskOption,
  type FilterPreset,
  type ProjectBoardSettings,
  type ProjectScope,
  type ProjectScopeView,
  type SecretMutation,
  type TrackerProject,
  type TrackerView,
  type TrelloBoardOption,
  type TrelloListOption,
  type TrelloRpcContract,
  type WorkAttachment,
  type WorkItem,
  type WorkItemDetail,
  type WorkItemFilterField,
  type WorkStateCategory,
  type WorkStatusOption
} from './contract.js';
import { FILTER_PRESET_NAME_MAX_LENGTH } from './filter-presets.js';
// Straight from app-key.js, not the trello/ barrel: the barrel pulls in the
// transport and node:crypto, neither of which belongs in the app bundle.
import { TRELLO_POWER_UP_ADMIN_URL } from './trello/app-key.js';
import {
  DEFAULT_WORKFLOW_STATUS_ORDER,
  assigneeAvatarIdentity,
  assigneeFilterOptions,
  canonicalizeSelectedFilterOptions,
  filterWorkItemsByAttributes,
  formatAttachmentSize,
  isFilterOptionSelected,
  isGroupCollapsed,
  labelFilterOptions,
  sortWorkItemsByWorkflow,
  statusFilterOptions,
  toggleFilterOptionSelection,
  toggleGroupCollapsedOverride,
  workflowStatusGroups,
  workflowStatusLaneKey,
  workflowStatusLanes,
  workflowStatusTone,
  type FilterOption,
  type WorkItemAttributeFilters
} from './board-view.js';
import './app.css';

const PANEL_PATH = 'board';
const THREAD_PANEL_ACTION_ID = 'trello-panel';
const RIGHT_PANEL_PINNED_STORAGE_KEY = 'bb-trello:right-panel-pinned';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'bb-trello:sidebar-collapsed';
const LAST_PROJECT_STORAGE_KEY = 'bb-trello:last-project';
const LAST_ROUTE_STORAGE_KEY = 'bb-trello:last-route';
const CREATE_METADATA_NETWORK_ERROR =
  'Trello could not load card creation options. Check the connection and try again.';
const BOARD_SEARCH_DEBOUNCE_MS = 250;

const STATE_CATEGORY_ORDER: readonly WorkStateCategory[] = [
  'in_progress',
  'todo',
  'done'
];

const STATE_CATEGORY_LABELS: Readonly<Record<WorkStateCategory, string>> = {
  todo: 'Todo',
  in_progress: 'In progress',
  done: 'Done'
};

interface FilterPresentation {
  label: string;
  icon: IconName;
}

const FILTER_PRESENTATION: Record<WorkItemFilterField, FilterPresentation> = {
  state: { label: 'State', icon: 'Circle' },
  status: { label: 'List', icon: 'Columns2' },
  assignee: { label: 'Member', icon: 'UserRound' },
  labels: { label: 'Labels', icon: 'Layers' }
};

const ALL_FILTER_FIELDS: readonly WorkItemFilterField[] = [
  'state',
  'status',
  'assignee',
  'labels'
];

type TrackerRoute =
  | { kind: 'root' }
  | { kind: 'project'; projectId: string }
  | { kind: 'manage'; projectId: string | null }
  | { kind: 'item'; projectId: string; locator: string };

interface BoardFilterState {
  query: string;
  view: TrackerView;
  stateCategories: WorkStateCategory[];
  statuses: string[];
  assignees: string[];
  labels: string[];
  collapsedGroups: Record<string, boolean>;
}

function defaultFilterState(view: TrackerView = 'list'): BoardFilterState {
  return {
    query: '',
    view,
    stateCategories: [],
    statuses: [],
    assignees: [],
    labels: [],
    collapsedGroups: {}
  };
}

function loadLastProjectId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Persistence is best-effort in sandboxed browser contexts.
  }
}

/**
 * The panel's own route, so reopening the tab returns to the ticket that was
 * open rather than resetting to the project's list. Kept in localStorage next
 * to the other panel-chrome preferences; the board's filters live server-side
 * because they are per project, while this is "where was I".
 */
function loadLastRoute(): string | null {
  try {
    return window.localStorage.getItem(LAST_ROUTE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastRoute(subPath: string): void {
  try {
    window.localStorage.setItem(LAST_ROUTE_STORAGE_KEY, subPath);
  } catch {
    // Persistence is best-effort in sandboxed browser contexts.
  }
}

function loadSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function storeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? 'true' : 'false'
    );
  } catch {
    // Best-effort.
  }
}

function loadRightPanelPinned(): boolean {
  try {
    return window.localStorage.getItem(RIGHT_PANEL_PINNED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function storeRightPanelPinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(
      RIGHT_PANEL_PINNED_STORAGE_KEY,
      pinned ? 'true' : 'false'
    );
  } catch {
    // Best-effort.
  }
}

// Trello locators are 24-character hex ids today, but this round-trips any
// opaque string safely through a bb route segment (mirrors the Taskboard
// template's locator encoding).
function encodeLocator(locator: string): string {
  return encodeURIComponent(locator).replaceAll('~', '%7E').replaceAll('%', '~');
}

function decodeLocator(locator: string): string {
  try {
    return decodeURIComponent(locator.replaceAll('~', '%'));
  } catch {
    return '';
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseTrackerRoute(rawSubPath: string): TrackerRoute {
  const path = rawSubPath.split('?', 1)[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const head = segments[0];
  if (head === undefined) return { kind: 'root' };
  if (head === 'manage') {
    const projectId = segments[1];
    return { kind: 'manage', projectId: projectId ? decodeSegment(projectId) : null };
  }
  const projectId = decodeSegment(head);
  if (segments[1] === 'item' && segments[2]) {
    return { kind: 'item', projectId, locator: decodeLocator(segments[2]) };
  }
  return { kind: 'project', projectId };
}

function routeToSubPath(route: TrackerRoute): string {
  if (route.kind === 'root') return '';
  if (route.kind === 'manage') {
    return route.projectId
      ? `manage/${encodeURIComponent(route.projectId)}`
      : 'manage';
  }
  if (route.kind === 'item') {
    return `${encodeURIComponent(route.projectId)}/item/${encodeLocator(route.locator)}`;
  }
  return encodeURIComponent(route.projectId);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function changedProjectId(payload: unknown): string | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('projectId' in payload) ||
    typeof (payload as { projectId: unknown }).projectId !== 'string'
  ) {
    return null;
  }
  return (payload as { projectId: string }).projectId;
}

/**
 * Shared "start a thread from this task" handler, reused by the detail view's
 * primary button and the list row / kanban card overflow menus so the RPC
 * call, navigation, and error toast live in exactly one place. The thread
 * opens in the bb project the board is already scoped to — no project
 * picker, on purpose.
 */
function useStartThread() {
  const rpc = useRpc<TrelloRpcContract>();
  const navigate = useBbNavigate();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const start = useCallback(
    async (
      item: Pick<WorkItem, 'bbProjectId' | 'locator' | 'key'>,
      environment: 'project-default' | 'worktree' = 'project-default'
    ) => {
      const itemId = `${item.bbProjectId}:${item.locator}`;
      setPendingId(itemId);
      try {
        const result = await rpc.call('startThread', {
          projectId: item.bbProjectId,
          locator: item.locator,
          instruction: '',
          environment
        });
        navigate.toThread(result.threadId);
      } catch (error) {
        toast.error(`Could not start an agent for ${item.key}`, {
          description: describeError(error)
        });
      } finally {
        setPendingId(current => (current === itemId ? null : current));
      }
    },
    [navigate, rpc]
  );

  return { pendingId, start };
}

function useRefreshOnReconnect(refresh: () => void): void {
  const connectionState = useRealtimeConnectionState();
  const previousStateRef = useRef(connectionState);
  const hasConnectedRef = useRef(connectionState !== 'connecting');
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (
      connectionState === 'connected' &&
      hasConnectedRef.current &&
      previousStateRef.current !== 'connected'
    ) {
      refreshRef.current();
    }
    if (connectionState === 'connected') hasConnectedRef.current = true;
    previousStateRef.current = connectionState;
  }, [connectionState]);
}

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  }).format(new Date(timestamp));
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function WorkStateGlyph({
  category,
  className = 'size-4'
}: {
  category: WorkStateCategory;
  className?: string;
}) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.5
  };
  return (
    <svg
      aria-hidden="true"
      data-state-category={category}
      className={cn('tb-state-glyph shrink-0', className)}
      viewBox="0 0 16 16"
    >
      {category === 'todo' ? (
        <circle {...common} cx="8" cy="8" r="5.25" />
      ) : category === 'in_progress' ? (
        <>
          <circle {...common} cx="8" cy="8" r="5.25" opacity="0.35" />
          <path {...common} d="M8 2.75a5.25 5.25 0 0 1 0 10.5" strokeWidth="2" />
        </>
      ) : (
        <>
          <circle {...common} cx="8" cy="8" r="5.25" />
          <path {...common} d="m5.35 8.05 1.7 1.75 3.65-3.7" />
        </>
      )}
    </svg>
  );
}

function AssigneeMark({ assignee }: { assignee: string }) {
  const identity = assigneeAvatarIdentity(assignee);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`Assigned to ${assignee}`}
          data-assignee-tone={identity.tone}
          className="tb-assignee-mark shrink-0"
        >
          <span aria-hidden="true">{identity.initials}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Assigned to {assignee}</TooltipContent>
    </Tooltip>
  );
}

function visibleAssignee(assignee: string | null): string | null {
  const value = assignee?.trim();
  return value ? value : null;
}


/**
 * Trello serves attachment bytes from trello.com behind a
 * browser session cookie, not the API token — a token-authenticated fetch
 * 302s to a login page. So this never renders `<img src>`; it renders a
 * clickable chip that hands the server-provided URL to `openUrl`, which opens
 * it in the user's browser where their Trello session is live.
 */
function AttachmentChip({
  attachment,
  onOpen
}: {
  attachment: WorkAttachment;
  onOpen: (url: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(attachment.url)}
      title={attachment.name}
      className="tb-attachment-chip inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-foreground hover:bg-secondary"
    >
      <Icon
        name={attachment.isImage ? 'FileAttachment' : 'File'}
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 truncate">{attachment.name}</span>
      <span className="shrink-0 text-muted-foreground">
        {formatAttachmentSize(attachment.size)}
      </span>
    </button>
  );
}

function AttachmentList({
  attachments,
  onOpen
}: {
  attachments: readonly WorkAttachment[];
  onOpen: (url: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map(attachment => (
        <AttachmentChip key={attachment.id} attachment={attachment} onOpen={onOpen} />
      ))}
    </div>
  );
}

function EmptyState({
  filtered,
  onClear
}: {
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <div className="tb-empty-state flex h-full flex-col items-center justify-center gap-3 rounded-lg p-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon name={filtered ? 'Search' : 'ListTodo'} className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {filtered ? 'No tasks match these filters' : 'No tasks yet'}
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {filtered
            ? 'Try a different status, assignee, or search query.'
            : 'Use Manage to map this project to a Trello board, then refresh.'}
        </p>
      </div>
      {filtered ? (
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="px-3.5 pt-3">
      <Skeleton className="mb-3 h-4 w-28" />
      {Array.from({ length: 7 }, (_, index) => (
        <div
          key={index}
          className="flex h-[34px] items-center gap-2 border-b border-border-hairline"
        >
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function TrackerSearchInput({
  query,
  onQueryChange
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  return (
    <div className="tb-search-shell flex h-8 items-center gap-1.5 rounded-md px-2">
      <Icon name="Search" className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        placeholder="Search tasks…"
        aria-label="Search tasks"
        className="tb-search-input h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => onQueryChange('')}
        >
          <Icon name="X" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function TrackerViewToggle({
  view,
  onViewChange
}: {
  view: TrackerView;
  onViewChange: (view: TrackerView) => void;
}) {
  return (
    <div className="tb-view-toggle flex h-7 shrink-0 items-center gap-0.5 rounded-md p-0.5">
      {(['list', 'kanban'] as const).map(option => (
        <button
          key={option}
          type="button"
          data-active={view === option ? 'true' : 'false'}
          aria-pressed={view === option}
          aria-label={option === 'list' ? 'List view' : 'Kanban view'}
          className="tb-view-toggle-option flex h-full items-center gap-1 rounded px-2 text-xs transition-colors"
          onClick={() => onViewChange(option)}
        >
          <Icon name={option === 'list' ? 'ListView' : 'Columns2'} className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

function FilterPresetMenu({
  presets,
  error,
  refreshError,
  loading,
  onApply,
  onRetry,
  onSaveCurrent
}: {
  presets: readonly FilterPreset[];
  error: string | null;
  refreshError: string | null;
  loading: boolean;
  onApply: (preset: FilterPreset) => void;
  onRetry: () => void;
  onSaveCurrent: () => void;
}) {
  const hasLoadIssue = error !== null || refreshError !== null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="tb-filter-chip h-7 shrink-0 gap-1.5 px-2 text-xs"
          data-active={hasLoadIssue ? 'true' : 'false'}
          aria-label={hasLoadIssue ? 'Filter presets need attention' : 'Filter presets'}
        >
          <Icon name={hasLoadIssue ? 'AlertCircle' : 'Star'} className="size-3.5" />
          Presets
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {loading ? (
          <DropdownMenuItem disabled>Loading presets…</DropdownMenuItem>
        ) : error ? (
          <>
            <div role="alert" className="px-2 py-1.5 text-xs leading-relaxed text-destructive">
              Could not load presets: {error}
            </div>
            <DropdownMenuItem onSelect={onRetry}>
              <Icon name="ArrowReloadHorizontal" className="size-3.5" />
              Try again
            </DropdownMenuItem>
          </>
        ) : presets.length === 0 ? (
          <DropdownMenuItem disabled>No saved presets</DropdownMenuItem>
        ) : (
          presets.map(preset => (
            <DropdownMenuItem key={preset.id} onSelect={() => onApply(preset)}>
              <Icon name="Star" className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{preset.name}</span>
            </DropdownMenuItem>
          ))
        )}
        {refreshError && !error ? (
          <div
            role="alert"
            className="mt-1 border-t border-border px-2 py-2 text-xs leading-relaxed text-muted-foreground"
          >
            Could not refresh presets.
            <button
              type="button"
              className="ml-1 font-medium text-foreground underline-offset-2 hover:underline"
              onClick={onRetry}
            >
              Try again
            </button>
          </div>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSaveCurrent}>
          <Icon name="Plus" className="size-3.5" />
          Save current view as…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TrackerFilterBar({
  presets,
  presetsError,
  presetsRefreshError,
  presetsLoading,
  onApplyPreset,
  onRetryPresets,
  onSaveCurrentPreset,
  enabledFilters,
  filters,
  statusOptions,
  assigneeOptions,
  labelOptions,
  onFiltersChange,
  onClear
}: {
  presets: readonly FilterPreset[];
  presetsError: string | null;
  presetsRefreshError: string | null;
  presetsLoading: boolean;
  onApplyPreset: (preset: FilterPreset) => void;
  onRetryPresets: () => void;
  onSaveCurrentPreset: () => void;
  enabledFilters: readonly WorkItemFilterField[];
  filters: BoardFilterState;
  statusOptions: readonly FilterOption[];
  assigneeOptions: readonly FilterOption[];
  labelOptions: readonly FilterOption[];
  onFiltersChange: (next: Partial<BoardFilterState>) => void;
  onClear: () => void;
}) {
  const keepOpen = (event: Event) => event.preventDefault();
  const activeFacetCount = [
    enabledFilters.includes('state') && filters.stateCategories.length > 0,
    enabledFilters.includes('status') && filters.statuses.length > 0,
    enabledFilters.includes('assignee') && filters.assignees.length > 0,
    enabledFilters.includes('labels') && filters.labels.length > 0
  ].filter(Boolean).length;
  const filtered = activeFacetCount > 0 || filters.query.trim() !== '';

  return (
    <div
      role="search"
      aria-label="Filter cards"
      className="tb-filter-bar flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1.5"
    >
      <div className="min-w-40 flex-1">
        <TrackerSearchInput
          query={filters.query}
          onQueryChange={query => onFiltersChange({ query })}
        />
      </div>
      <TrackerViewToggle
        view={filters.view}
        onViewChange={view => onFiltersChange({ view })}
      />
      <FilterPresetMenu
        presets={presets}
        error={presetsError}
        refreshError={presetsRefreshError}
        loading={presetsLoading}
        onApply={onApplyPreset}
        onRetry={onRetryPresets}
        onSaveCurrent={onSaveCurrentPreset}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="tb-filter-chip h-7 shrink-0 gap-1.5 px-2 text-xs"
            data-active={activeFacetCount > 0 ? 'true' : 'false'}
            aria-label={`Filters, ${activeFacetCount} active`}
          >
            <Icon name="SlidersHorizontal" className="size-3.5" />
            Filters{activeFacetCount > 0 ? ` · ${activeFacetCount}` : ''}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-[min(28rem,70vh)] w-72 overflow-y-auto"
        >
          {enabledFilters.includes('state') ? (
            <>
              <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon name={FILTER_PRESENTATION.state.icon} className="size-3.5" />
                State
              </DropdownMenuLabel>
              {STATE_CATEGORY_ORDER.map(category => (
                <DropdownMenuCheckboxItem
                  key={category}
                  checked={filters.stateCategories.includes(category)}
                  onSelect={keepOpen}
                  onCheckedChange={checked => {
                    onFiltersChange({
                      stateCategories: checked
                        ? [...filters.stateCategories, category]
                        : filters.stateCategories.filter(value => value !== category)
                    });
                  }}
                >
                  {STATE_CATEGORY_LABELS[category]}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          {(
            [
              ['status', statusOptions, filters.statuses, 'statuses'],
              ['assignee', assigneeOptions, filters.assignees, 'assignees'],
              ['labels', labelOptions, filters.labels, 'labels']
            ] as const
          ).map(([field, options, selected, key]) =>
            enabledFilters.includes(field) ? (
              <div key={field}>
                <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon name={FILTER_PRESENTATION[field].icon} className="size-3.5" />
                  {FILTER_PRESENTATION[field].label}
                </DropdownMenuLabel>
                {options.length === 0 ? (
                  <DropdownMenuItem disabled>None found</DropdownMenuItem>
                ) : (
                  options.map(option => (
                    <DropdownMenuCheckboxItem
                      key={option.value}
                      checked={isFilterOptionSelected(selected, option.value)}
                      onSelect={keepOpen}
                      onCheckedChange={() => {
                        onFiltersChange({
                          [key]: toggleFilterOptionSelection(selected, option.value)
                        });
                      }}
                    >
                      {option.label}
                    </DropdownMenuCheckboxItem>
                  ))
                )}
                <DropdownMenuSeparator />
              </div>
            ) : null
          )}
          <DropdownMenuItem onSelect={onClear} disabled={!filtered}>
            <Icon name="X" className="size-3.5" />
            Clear all filters
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status + assignee editing
// ---------------------------------------------------------------------------

function WorkItemStatusMenu({
  item,
  variant,
  onMove
}: {
  item: WorkItem;
  variant: 'row' | 'detail';
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
}) {
  const rpc = useRpc<TrelloRpcContract>();
  const [options, setOptions] = useState<WorkStatusOption[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [pendingStatusId, setPendingStatusId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const identity = `${item.bbProjectId}:${item.locator}`;

  useEffect(() => {
    setOptions(undefined);
    setError(null);
  }, [identity, item.status]);

  const loadOptions = useCallback(async () => {
    if (loading || options !== undefined) return;
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call('statusOptions', {
        projectId: item.bbProjectId,
        locator: item.locator
      });
      setOptions(result.options);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setLoading(false);
    }
  }, [item.bbProjectId, item.locator, loading, options, rpc]);

  const changeStatus = async (option: WorkStatusOption) => {
    if (option.current || pendingStatusId !== null) return;
    setPendingStatusId(option.id);
    try {
      await onMove(item, option);
      toast.success(`${item.key} moved to ${option.name}`);
    } catch (nextError) {
      toast.error(`Could not update ${item.key}`, {
        description: describeError(nextError)
      });
    } finally {
      setPendingStatusId(null);
    }
  };

  const trigger =
    variant === 'row' ? (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-5 rounded-full p-0"
        aria-label={`Change status for ${item.key}. Current status: ${item.status}`}
        disabled={pendingStatusId !== null}
      >
        <WorkStateGlyph category={item.stateCategory} />
      </Button>
    ) : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="tb-status-pill h-7 gap-1.5 rounded-full px-2.5 text-xs"
        data-state-category={item.stateCategory}
        data-status-tone={workflowStatusTone(item.status, item.stateCategory)}
        disabled={pendingStatusId !== null}
      >
        <WorkStateGlyph category={item.stateCategory} />
        {pendingStatusId === null ? item.status : 'Updating…'}
        <Icon name="ChevronDown" className="size-3 opacity-60" />
      </Button>
    );

  return (
    <DropdownMenu onOpenChange={open => (open ? void loadOptions() : undefined)}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={variant === 'row' ? 'start' : 'end'} className="min-w-48">
        {loading && options === undefined ? (
          <DropdownMenuItem disabled>
            <Icon name="Loading" className="size-3.5 animate-spin" />
            Loading statuses…
          </DropdownMenuItem>
        ) : error ? (
          <DropdownMenuItem disabled className="max-w-64 text-destructive">
            {error}
          </DropdownMenuItem>
        ) : options?.length ? (
          options.map(option => (
            <DropdownMenuItem
              key={option.id}
              disabled={option.current || pendingStatusId !== null}
              onSelect={() => void changeStatus(option)}
            >
              <WorkStateGlyph category={option.stateCategory} />
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {option.current ? <Icon name="Check" className="size-3.5" /> : null}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>No status changes available</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * There is no "list assignable people" RPC on its own — the only exposed
 * source is `getCreateTaskMetadata`'s `assigneeOptions`, scoped to the bb
 * project's mapped Trello board. Reused here rather than adding a
 * near-duplicate RPC just for this menu.
 */
function WorkItemAssigneeMenu({
  item,
  onChange
}: {
  item: WorkItem;
  onChange: (assigneeId: string | null) => Promise<void>;
}) {
  const rpc = useRpc<TrelloRpcContract>();
  const [options, setOptions] = useState<CreateTaskOption[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const loadOptions = useCallback(async () => {
    if (loading || options !== undefined) return;
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call('getCreateTaskMetadata', {
        projectId: item.bbProjectId
      });
      if (!result.ok) {
        setError(result.error.safeMessage);
        return;
      }
      setOptions(result.metadata.assigneeOptions);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setLoading(false);
    }
  }, [item.bbProjectId, loading, options, rpc]);

  const changeAssignee = async (assigneeId: string | null) => {
    if (pending) return;
    setPending(true);
    try {
      await onChange(assigneeId);
    } catch (nextError) {
      toast.error(`Could not update ${item.key}`, {
        description: describeError(nextError)
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <DropdownMenu onOpenChange={open => (open ? void loadOptions() : undefined)}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
          disabled={pending}
        >
          <Icon name="UserRound" className="size-3.5 text-muted-foreground" />
          {pending ? 'Updating…' : (item.assignee ?? 'Unassigned')}
          <Icon name="ChevronDown" className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 min-w-48 overflow-y-auto">
        {loading && options === undefined ? (
          <DropdownMenuItem disabled>
            <Icon name="Loading" className="size-3.5 animate-spin" />
            Loading people…
          </DropdownMenuItem>
        ) : error ? (
          <DropdownMenuItem disabled className="max-w-64 text-destructive">
            {error}
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem disabled={pending} onSelect={() => void changeAssignee(null)}>
              <span className="text-muted-foreground">Unassigned</span>
              {item.assigneeId === null ? (
                <Icon name="Check" className="ml-auto size-3.5" />
              ) : null}
            </DropdownMenuItem>
            {options?.map(option => (
              <DropdownMenuItem
                key={option.id}
                disabled={pending}
                onSelect={() => void changeAssignee(option.id)}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {item.assigneeId === option.id ? (
                  <Icon name="Check" className="size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A single "Start agent" row, shared by the row and card overflow menus. */
function StartThreadMenuItem({
  item,
  canStart,
  pending,
  onStart
}: {
  item: WorkItem;
  canStart: boolean;
  pending: boolean;
  onStart: (item: WorkItem, environment?: 'project-default' | 'worktree') => void;
}) {
  return (
    <DropdownMenuItem disabled={!canStart || pending} onSelect={() => onStart(item)}>
      <Icon
        name={pending ? 'Loading' : 'MessageSquarePlus'}
        className={cn('size-3.5', pending && 'animate-spin')}
      />
      {pending ? 'Starting agent…' : 'Start agent'}
    </DropdownMenuItem>
  );
}

/** Row/card overflow menu: "Start agent" plus its worktree variant. */
function ItemOverflowMenu({
  item,
  canStartThread,
  startThreadPending,
  onStartThread
}: {
  item: WorkItem;
  canStartThread: boolean;
  startThreadPending: boolean;
  onStartThread: (item: WorkItem, environment?: 'project-default' | 'worktree') => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 rounded-full p-0 text-muted-foreground"
          aria-label={`More actions for ${item.key}`}
        >
          <Icon name="MoreHorizontal" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <StartThreadMenuItem
          item={item}
          canStart={canStartThread}
          pending={startThreadPending}
          onStart={onStartThread}
        />
        <DropdownMenuItem
          disabled={!canStartThread || startThreadPending}
          onSelect={() => onStartThread(item, 'worktree')}
        >
          <Icon
            name={startThreadPending ? 'Loading' : 'GitBranch'}
            className={cn('size-3.5', startThreadPending && 'animate-spin')}
          />
          <span className="min-w-0 flex-1">
            Start agent in a new worktree
            <span className="block text-2xs text-muted-foreground">
              Gives the ticket its own checkout, so parallel tickets don't collide.
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function WorkItemRow({
  item,
  onMove,
  onOpen,
  canStartThread,
  startThreadPending,
  onStartThread
}: {
  item: WorkItem;
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
  onOpen: () => void;
  canStartThread: boolean;
  startThreadPending: boolean;
  onStartThread: (item: WorkItem, environment?: 'project-default' | 'worktree') => void;
}) {
  const assignee = visibleAssignee(item.assignee);
  return (
    <div
      data-state-category={item.stateCategory}
      data-status-tone={workflowStatusTone(item.status, item.stateCategory)}
      className="tb-item-row group relative grid min-h-9 w-full items-center gap-x-2 border-b border-border-hairline px-2.5 py-1 text-left"
    >
      <button
        type="button"
        aria-label={`Open ${item.key}: ${item.title}.${assignee ? ` Assigned to ${assignee}.` : ''}`}
        onClick={onOpen}
        className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <span className="relative z-10 flex items-center justify-center">
        <WorkItemStatusMenu item={item} variant="row" onMove={onMove} />
      </span>
      <span className="tb-key pointer-events-none relative z-[1] min-w-0 truncate text-xs font-medium tabular-nums">
        {item.key}
      </span>
      <span className="pointer-events-none relative z-[1] min-w-0 truncate text-[13px] font-medium text-foreground">
        {item.title}
      </span>
      <span className="tb-row-trailing tb-meta relative z-[1] flex min-w-0 items-center gap-2 overflow-hidden text-xs">
        <span className="pointer-events-none flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="max-w-40 truncate text-muted-foreground" title={item.status}>
            {item.status}
          </span>
          {assignee ? <AssigneeMark assignee={assignee} /> : null}
        </span>
        <span className="relative z-10">
          <ItemOverflowMenu
            item={item}
            canStartThread={canStartThread}
            startThreadPending={startThreadPending}
            onStartThread={onStartThread}
          />
        </span>
      </span>
    </div>
  );
}

function ListStateGroups({
  items,
  statusOrder,
  collapsedGroups,
  searchActive,
  onToggleGroup,
  onMove,
  onOpen,
  canStartThread,
  startThreadPendingId,
  onStartThread
}: {
  items: readonly WorkItem[];
  statusOrder: readonly string[];
  collapsedGroups: Readonly<Record<string, boolean>>;
  searchActive: boolean;
  onToggleGroup: (groupKey: string, category: WorkStateCategory) => void;
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
  onOpen: (item: WorkItem) => void;
  canStartThread: boolean;
  startThreadPendingId: string | null;
  onStartThread: (item: WorkItem, environment?: 'project-default' | 'worktree') => void;
}) {
  return (
    <>
      {workflowStatusGroups(items, statusOrder).map(group => {
        const headingId = `board-state-${encodeURIComponent(group.key)}`;
        const contentId = `${headingId}-items`;
        const collapsed = isGroupCollapsed({
          overrides: collapsedGroups,
          groupKey: group.key,
          category: group.category,
          searchActive
        });
        return (
          <section key={group.key} aria-labelledby={headingId}>
            <h3
              id={headingId}
              data-state-category={group.category}
              data-status-tone={workflowStatusTone(group.name, group.category)}
              className="tb-group-heading sticky top-0 z-10 h-8 border-b backdrop-blur-sm"
            >
              <button
                type="button"
                aria-controls={contentId}
                aria-expanded={!collapsed}
                disabled={searchActive}
                className="flex h-full w-full items-center gap-2 px-2.5 text-left text-2xs font-semibold uppercase tracking-[0.12em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
                onClick={() => onToggleGroup(group.key, group.category)}
              >
                <Icon
                  name="ChevronDown"
                  className={cn('size-3 transition-transform', collapsed && '-rotate-90')}
                />
                <WorkStateGlyph category={group.category} />
                <span className="truncate">{group.name}</span>
                <span className="tb-count-chip ml-auto rounded-full px-1.5 py-0.5 text-xs font-normal tabular-nums">
                  {group.items.length}
                </span>
              </button>
            </h3>
            <div id={contentId} hidden={collapsed}>
              {group.items.map(item => (
                <WorkItemRow
                  key={`${item.bbProjectId}:${item.locator}`}
                  item={item}
                  onMove={onMove}
                  onOpen={() => onOpen(item)}
                  canStartThread={canStartThread}
                  startThreadPending={startThreadPendingId === `${item.bbProjectId}:${item.locator}`}
                  onStartThread={onStartThread}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Kanban view
// ---------------------------------------------------------------------------

function kanbanItemId(item: WorkItem): string {
  return `${item.bbProjectId}:${item.locator}`;
}

function KanbanCard({
  item,
  pickedUp,
  pending,
  onOpen,
  onDragStart,
  onDragEnd,
  onKeyDown,
  canStartThread,
  startThreadPending,
  onStartThread
}: {
  item: WorkItem;
  pickedUp: boolean;
  pending: boolean;
  onOpen: () => void;
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  canStartThread: boolean;
  startThreadPending: boolean;
  onStartThread: (item: WorkItem, environment?: 'project-default' | 'worktree') => void;
}) {
  const assignee = visibleAssignee(item.assignee);
  const labels = item.labels.map(label => label.trim()).filter(Boolean).slice(0, 2);

  return (
    <div className="relative">
      <button
        type="button"
        draggable={!pending}
        aria-grabbed={pickedUp}
        aria-busy={pending}
        aria-label={`${item.key}: ${item.title}. List ${item.status}.${assignee ? ` Assigned to ${assignee}.` : ''} Press Space to move, or Enter to open.`}
        data-state-category={item.stateCategory}
        data-status-tone={workflowStatusTone(item.status, item.stateCategory)}
        data-picked-up={pickedUp ? 'true' : 'false'}
        data-pending={pending ? 'true' : 'false'}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onKeyDown={onKeyDown}
        onClick={onOpen}
        className="tb-kanban-card group w-full rounded-md px-3 py-2.5 pr-8 text-left transition-[border-color,background-color,opacity,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2 text-xs">
          <span className="tb-key min-w-0 truncate font-medium tabular-nums">{item.key}</span>
        </span>
        <span className="mt-1.5 flex items-start gap-1.5">
          <span className="mt-1 flex shrink-0">
            <WorkStateGlyph category={item.stateCategory} />
          </span>
          <span className="line-clamp-2 block text-sm font-medium leading-snug text-foreground">
            {item.title}
          </span>
        </span>
        {labels.length > 0 ? (
          <span className="mt-2 flex min-w-0 gap-1 overflow-hidden">
            {labels.map((label, index) => (
              <span
                key={`${label}-${index}`}
                className="tb-label-chip min-w-0 truncate rounded-full px-2 py-0.5 text-xs"
                title={label}
              >
                {label}
              </span>
            ))}
          </span>
        ) : null}
        <span className="tb-meta mt-2 flex min-w-0 items-center gap-2 text-xs">
          <time className="shrink-0 tabular-nums" dateTime={item.updatedAt}>
            Updated {formatUpdatedAt(item.updatedAt)}
          </time>
          {pending ? (
            <span className="ml-auto min-w-0 truncate">Updating…</span>
          ) : assignee ? (
            <span className="ml-auto flex shrink-0">
              <AssigneeMark assignee={assignee} />
            </span>
          ) : null}
        </span>
      </button>
      <span className="absolute right-1.5 top-1.5">
        <ItemOverflowMenu
          item={item}
          canStartThread={canStartThread}
          startThreadPending={startThreadPending}
          onStartThread={onStartThread}
        />
      </span>
    </div>
  );
}

/**
 * Why there is no per-card "which statuses can this move to?" round trip: on
 * Trello every list on the board is a legal destination for every card on it,
 * so the board's lists (loaded once) are the complete move target set.
 */
function KanbanBoard({
  items,
  lists,
  statusOrder,
  onOpen,
  onMove,
  canStartThread,
  startThreadPendingId,
  onStartThread
}: {
  items: readonly WorkItem[];
  lists: readonly TrelloListOption[];
  statusOrder: readonly string[];
  onOpen: (item: WorkItem) => void;
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
  canStartThread: boolean;
  startThreadPendingId: string | null;
  onStartThread: (item: WorkItem, environment?: 'project-default' | 'worktree') => void;
}) {
  const draggedItemRef = useRef<WorkItem | null>(null);
  const suppressOpenRef = useRef<string | null>(null);
  const [pickup, setPickup] = useState<{
    item: WorkItem;
    targetLane: string | null;
    mode: 'pointer' | 'keyboard';
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [visibleMessage, setVisibleMessage] = useState<string | null>(null);

  const discovered = useMemo<WorkStatusOption[]>(
    () =>
      lists.map(list => ({
        id: list.id,
        name: list.name,
        stateCategory: list.stateCategory,
        current: false
      })),
    [lists]
  );
  const lanes = useMemo(
    () => workflowStatusLanes(items, discovered, statusOrder),
    [discovered, items, statusOrder]
  );

  /** The move target for a lane, or undefined when the card is already there. */
  const optionForLane = useCallback(
    (item: WorkItem, laneKey: string): WorkStatusOption | undefined => {
      const list = lists.find(
        candidate =>
          workflowStatusLaneKey(candidate.name, candidate.stateCategory) === laneKey
      );
      if (!list || list.id === item.statusId) return undefined;
      return {
        id: list.id,
        name: list.name,
        stateCategory: list.stateCategory,
        current: false
      };
    },
    [lists]
  );

  const moveTargets = useCallback(
    (item: WorkItem) => lists.filter(list => list.id !== item.statusId),
    [lists]
  );

  const beginPickup = useCallback(
    (item: WorkItem, mode: 'pointer' | 'keyboard') => {
      const targets = moveTargets(item);
      if (targets.length === 0) {
        const message = `${item.key} has no other list to move to.`;
        setVisibleMessage(message);
        setAnnouncement(message);
        return;
      }
      const first = targets[0]!;
      setVisibleMessage(null);
      setPickup({
        item,
        targetLane: workflowStatusLaneKey(first.name, first.stateCategory),
        mode
      });
      setAnnouncement(
        `${item.key} picked up. ${targets.length} list ${targets.length === 1 ? 'target' : 'targets'} available. ${first.name} selected.`
      );
    },
    [moveTargets]
  );

  const commitMove = useCallback(
    async (item: WorkItem, laneKey: string) => {
      if (pending) return;
      const option = optionForLane(item, laneKey);
      if (!option) {
        const message = `${item.key} cannot move to that list.`;
        setPickup(null);
        setVisibleMessage(message);
        setAnnouncement(message);
        return;
      }
      const itemId = kanbanItemId(item);
      setPending(itemId);
      setPickup(null);
      setVisibleMessage(null);
      setAnnouncement(`Moving ${item.key} to ${option.name}`);
      try {
        await onMove(item, option);
        setAnnouncement(`${item.key} moved to ${option.name}`);
      } catch (error) {
        const message = describeError(error);
        setVisibleMessage(`${item.key} stayed in ${item.status}. ${message}`);
        setAnnouncement(`${item.key} move failed. ${message}`);
      } finally {
        setPending(current => (current === itemId ? null : current));
      }
    },
    [onMove, optionForLane, pending]
  );

  const keyboardTargets = pickup ? moveTargets(pickup.item) : [];

  return (
    <div role="region" aria-label="Kanban board" className="tb-kanban-area h-full min-h-0 overflow-auto p-2">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
      {visibleMessage ? (
        <div
          role="alert"
          className="tb-kanban-feedback sticky left-0 top-0 z-30 mb-2 w-fit max-w-lg rounded-md border px-2.5 py-1.5 text-xs text-destructive"
        >
          {visibleMessage}
        </div>
      ) : null}
      {lanes.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No lists in the current results
        </div>
      ) : (
        <div dir="ltr" className="ml-0 mr-auto flex min-h-full min-w-max flex-row gap-2.5">
          {lanes.map(lane => {
            const columnItems = items.filter(
              item => workflowStatusLaneKey(item.status, item.stateCategory) === lane.key
            );
            const option = pickup ? optionForLane(pickup.item, lane.key) : undefined;
            const dropState = pickup
              ? option
                ? pickup.targetLane === lane.key
                  ? 'target'
                  : 'valid'
                : 'invalid'
              : 'idle';
            const headingId = `kanban-${encodeURIComponent(lane.key)}`;
            return (
              <section
                key={lane.key}
                aria-labelledby={headingId}
                aria-dropeffect={pickup && option ? 'move' : 'none'}
                data-drop-state={dropState}
                data-state-category={lane.category}
                data-status-tone={workflowStatusTone(lane.name, lane.category)}
                onDragOver={event => {
                  if (!pickup && !draggedItemRef.current) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setPickup(current => (current ? { ...current, targetLane: lane.key } : current));
                }}
                onDrop={event => {
                  event.preventDefault();
                  const item = draggedItemRef.current ?? pickup?.item;
                  draggedItemRef.current = null;
                  if (item) void commitMove(item, lane.key);
                }}
                className="tb-kanban-column flex w-[264px] min-w-[264px] flex-col rounded-lg border border-transparent"
              >
                <div className="tb-kanban-column-header sticky top-0 z-10 flex h-8 items-center gap-2 px-1">
                  <WorkStateGlyph category={lane.category} />
                  <h3 id={headingId} className="min-w-0 truncate text-xs font-semibold">
                    {lane.name}
                  </h3>
                  <span
                    aria-label={`${columnItems.length} ${columnItems.length === 1 ? 'card' : 'cards'}`}
                    className="tb-lane-count ml-auto text-xs tabular-nums"
                  >
                    {columnItems.length}
                  </span>
                </div>
                <div className="min-h-20 flex-1 space-y-1.5 p-1.5 pt-1">
                  {columnItems.length > 0 ? (
                    columnItems.map(item => {
                      const itemId = kanbanItemId(item);
                      const isThisPickup = pickup !== null && kanbanItemId(pickup.item) === itemId;
                      return (
                        <KanbanCard
                          key={itemId}
                          item={item}
                          pickedUp={isThisPickup}
                          pending={pending === itemId}
                          onDragStart={event => {
                            if (pending) {
                              event.preventDefault();
                              return;
                            }
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', itemId);
                            draggedItemRef.current = item;
                            suppressOpenRef.current = itemId;
                            beginPickup(item, 'pointer');
                          }}
                          onDragEnd={() => {
                            draggedItemRef.current = null;
                            setPickup(current => (current?.mode === 'pointer' ? null : current));
                            window.setTimeout(() => {
                              if (suppressOpenRef.current === itemId) suppressOpenRef.current = null;
                            }, 0);
                          }}
                          onKeyDown={event => {
                            if (!isThisPickup) {
                              if (event.key === ' ') {
                                event.preventDefault();
                                beginPickup(item, 'keyboard');
                              }
                              return;
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              setPickup(null);
                              setAnnouncement(`${item.key} move canceled`);
                              return;
                            }
                            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                              event.preventDefault();
                              const currentIndex = keyboardTargets.findIndex(
                                target =>
                                  workflowStatusLaneKey(target.name, target.stateCategory) ===
                                  pickup.targetLane
                              );
                              const direction = event.key === 'ArrowRight' ? 1 : -1;
                              const next =
                                keyboardTargets[
                                  (currentIndex + direction + keyboardTargets.length) %
                                    keyboardTargets.length
                                ];
                              if (!next) return;
                              const targetLane = workflowStatusLaneKey(
                                next.name,
                                next.stateCategory
                              );
                              setPickup(current => (current ? { ...current, targetLane } : current));
                              setAnnouncement(`${next.name} selected for ${item.key}`);
                              return;
                            }
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              if (pickup.targetLane) {
                                void commitMove(pickup.item, pickup.targetLane);
                              }
                            }
                          }}
                          onOpen={() => {
                            if (suppressOpenRef.current === itemId) {
                              suppressOpenRef.current = null;
                              return;
                            }
                            if (!pickup) onOpen(item);
                          }}
                          canStartThread={canStartThread}
                          startThreadPending={startThreadPendingId === itemId}
                          onStartThread={onStartThread}
                        />
                      );
                    })
                  ) : (
                    <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                      {dropState === 'target' ? 'Drop to move here' : 'No cards'}
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter presets (data hook)
// ---------------------------------------------------------------------------

function useProjectFilterPresets(projectId: string | null): {
  presets: readonly FilterPreset[];
  error: string | null;
  refreshError: string | null;
  loading: boolean;
  reload: (options?: { background?: boolean }) => Promise<void>;
  setAuthoritative: (presets: readonly FilterPreset[]) => void;
} {
  const rpc = useRpc<TrelloRpcContract>();
  const [presets, setPresets] = useState<readonly FilterPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loading, setLoading] = useState(projectId !== null);
  const requestRevisionRef = useRef(0);

  const reload = useCallback(
    async (options: { background?: boolean } = {}) => {
      const requestRevision = ++requestRevisionRef.current;
      if (projectId === null) {
        setPresets([]);
        setError(null);
        setRefreshError(null);
        setLoading(false);
        return;
      }
      if (!options.background) {
        setLoading(true);
        setError(null);
      }
      setRefreshError(null);
      try {
        const result = await rpc.call('listFilterPresets', { projectId });
        if (requestRevision !== requestRevisionRef.current) return;
        setPresets(result.presets);
        setError(null);
        setRefreshError(null);
      } catch (nextError) {
        if (requestRevision !== requestRevisionRef.current) return;
        const message = describeError(nextError);
        if (options.background) setRefreshError(message);
        else {
          setPresets([]);
          setError(message);
        }
      } finally {
        if (requestRevision === requestRevisionRef.current) setLoading(false);
      }
    },
    [projectId, rpc]
  );

  useEffect(() => {
    void reload();
    return () => {
      requestRevisionRef.current += 1;
    };
  }, [reload]);
  useRealtime(PRESETS_CHANGED, payload => {
    if (projectId === null) return;
    const changed = changedProjectId(payload);
    if (changed === null || changed === projectId) void reload({ background: true });
  });
  useRefreshOnReconnect(() => {
    if (projectId !== null) void reload({ background: true });
  });

  const setAuthoritative = useCallback(
    (nextPresets: readonly FilterPreset[]) => {
      requestRevisionRef.current += 1;
      setPresets(nextPresets);
      setError(null);
      setRefreshError(null);
      setLoading(false);
    },
    []
  );

  return { presets, error, refreshError, loading, reload, setAuthoritative };
}

/** Shared by saved presets and the persisted "last used view". */
function presetStateToFilterState(
  state: FilterPreset['state']
): BoardFilterState {
  return {
    query: state.query,
    view: state.view,
    stateCategories: [...state.stateCategories],
    statuses: [...state.statuses],
    assignees: [...state.assignees],
    labels: [...state.labels],
    collapsedGroups: { ...state.collapsedGroups }
  };
}

function presetToFilterState(preset: FilterPreset): BoardFilterState {
  return presetStateToFilterState(preset.state);
}

function filterStateToPresetState(filters: BoardFilterState) {
  return {
    version: 1 as const,
    view: filters.view,
    query: filters.query,
    stateCategories: filters.stateCategories,
    statuses: filters.statuses,
    assignees: filters.assignees,
    labels: filters.labels,
    collapsedGroups: filters.collapsedGroups
  };
}

// ---------------------------------------------------------------------------
// Board (list/kanban for one bb project)
// ---------------------------------------------------------------------------

function TrackerBoard({
  projectId,
  refreshGeneration,
  onOpen
}: {
  projectId: string;
  refreshGeneration: number;
  onOpen: (item: WorkItem) => void;
}) {
  const rpc = useRpc<TrelloRpcContract>();
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boardSettings, setBoardSettings] = useState<ProjectBoardSettings | null>(null);
  const [filters, setFilters] = useState<BoardFilterState>(defaultFilterState());
  const presetsState = useProjectFilterPresets(projectId);
  const [presetNameDraft, setPresetNameDraft] = useState<string | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetSaveError, setPresetSaveError] = useState<string | null>(null);
  const [canStartThread, setCanStartThread] = useState(false);
  const [boardLists, setBoardLists] = useState<readonly TrelloListOption[]>([]);
  const startThread = useStartThread();
  const requestRevisionRef = useRef(0);
  // Null until the persisted view for this project has been read. Nothing may
  // be written back before then, or the defaults this component mounts with
  // would clobber what the user left behind.
  const restoredProjectRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    restoredProjectRef.current = null;
    void rpc
      .call('getBoardView', { projectId })
      .then(result => {
        if (!active) return;
        if (result.view) {
          setFilters(presetStateToFilterState(result.view.state));
        }
        restoredProjectRef.current = projectId;
      })
      .catch(() => {
        // A board that cannot read its saved view still has to open.
        if (active) restoredProjectRef.current = projectId;
      });
    return () => {
      active = false;
    };
  }, [projectId, rpc]);

  useEffect(() => {
    if (restoredProjectRef.current !== projectId) return;
    // Debounced: filters change on every keystroke in the search box.
    const timer = setTimeout(() => {
      void rpc
        .call('saveBoardView', {
          projectId,
          view: { state: filterStateToPresetState(filters) }
        })
        .catch((cause: unknown) => {
          // Never block the board on a failed write, but do not swallow it
          // silently either: a rejected payload here presents as "the board
          // forgot my filters", with nothing to go on.
          console.warn('trello: could not save the board view', cause);
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [projectId, filters, rpc]);

  const load = useCallback(async () => {
    const requestRevision = ++requestRevisionRef.current;
    try {
      const [itemsResult, settingsResult, createTaskContextResult] = await Promise.all([
        rpc.call('listItems', { projectId, limit: 5000 }),
        rpc.call('getProjectBoardSettings', { projectId }),
        rpc.call('getCreateTaskContext', { projectId }).catch(() => null)
      ]);
      if (requestRevision !== requestRevisionRef.current) return;
      setItems(itemsResult.items);
      setBoardSettings(settingsResult.settings);
      setCanStartThread(createTaskContextResult?.context.available ?? false);
      setError(null);
      setFilters(current => ({ ...current, view: current.view }));
    } catch (nextError) {
      if (requestRevision !== requestRevisionRef.current) return;
      setError(describeError(nextError));
    }
  }, [projectId, rpc]);

  useEffect(() => {
    setItems(null);
    setBoardSettings(null);
    setFilters(defaultFilterState());
    void load();
    return () => {
      requestRevisionRef.current += 1;
    };
  }, [load, refreshGeneration, projectId]);

  useEffect(() => {
    // The project's default view is a starting point, not an override: once a
    // saved view has been restored it wins, otherwise reopening the board
    // would always snap back to the configured default.
    if (boardSettings && restoredProjectRef.current !== boardSettings.projectId) {
      setFilters(current => ({ ...current, view: boardSettings.defaultView }));
    }
    // Only apply the project's default view the first time settings load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardSettings?.projectId]);

  useRealtime(ITEMS_CHANGED, payload => {
    const changed = changedProjectId(payload);
    if (changed === null || changed === projectId) void load();
  });
  useRefreshOnReconnect(() => void load());

  const enabledFilters = boardSettings?.enabledFilters ?? ALL_FILTER_FIELDS;

  // The board's lists, in Trello's own `pos` order. They are the kanban lanes,
  // the move targets, and — once loaded — the lane order itself: a persisted
  // `statusOrder` is only the fallback for before they arrive.
  useEffect(() => {
    let active = true;
    setBoardLists([]);
    void rpc
      .call('listBoardLists', { projectId })
      .then(result => {
        if (active) setBoardLists(result.lists);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projectId, refreshGeneration, rpc]);

  const statusOrder = useMemo(
    () =>
      boardLists.length > 0
        ? boardLists.map(list => list.name)
        : (boardSettings?.statusOrder ?? DEFAULT_WORKFLOW_STATUS_ORDER),
    [boardLists, boardSettings]
  );

  const statusOptions = useMemo(
    () => statusFilterOptions(items ?? [], filters.statuses, statusOrder),
    [items, filters.statuses, statusOrder]
  );
  const assigneeOptions = useMemo(
    () => assigneeFilterOptions(items ?? [], filters.assignees),
    [items, filters.assignees]
  );
  const labelOptions = useMemo(
    () => labelFilterOptions(items ?? [], filters.labels),
    [items, filters.labels]
  );

  const filteredByQuery = useMemo(() => {
    const source = items ?? [];
    const query = filters.query.trim().toLocaleLowerCase();
    if (query === '') return source;
    return source.filter(
      item =>
        item.key.toLocaleLowerCase().includes(query) ||
        item.title.toLocaleLowerCase().includes(query)
    );
  }, [items, filters.query]);

  const attributeFilters: WorkItemAttributeFilters = {
    statuses: filters.statuses,
    assignees: filters.assignees,
    labels: filters.labels
  };
  const filteredItems = useMemo(() => {
    const byState =
      filters.stateCategories.length === 0
        ? filteredByQuery
        : filteredByQuery.filter(item => filters.stateCategories.includes(item.stateCategory));
    return sortWorkItemsByWorkflow(filterWorkItemsByAttributes(byState, attributeFilters), statusOrder);
  }, [filteredByQuery, filters.stateCategories, attributeFilters, statusOrder]);

  const applyFilters = (next: Partial<BoardFilterState>) => {
    setFilters(current => {
      const merged = { ...current, ...next };
      if (next.statuses)
        merged.statuses = canonicalizeSelectedFilterOptions(next.statuses, statusOptions);
      if (next.assignees)
        merged.assignees = canonicalizeSelectedFilterOptions(next.assignees, assigneeOptions);
      if (next.labels)
        merged.labels = canonicalizeSelectedFilterOptions(next.labels, labelOptions);
      return merged;
    });
  };

  const toggleGroup = (groupKey: string, category: WorkStateCategory) => {
    setFilters(current => ({
      ...current,
      collapsedGroups: toggleGroupCollapsedOverride(current.collapsedGroups, groupKey, category)
    }));
  };

  const moveItem = useCallback(
    async (item: WorkItem, option: WorkStatusOption) => {
      const result = await rpc.call('updateItemStatus', {
        projectId: item.bbProjectId,
        locator: item.locator,
        statusId: option.id
      });
      setItems(current =>
        current
          ? current.map(candidate => (candidate.locator === item.locator ? result.item : candidate))
          : current
      );
    },
    [rpc]
  );

  const saveCurrentPreset = async (name: string) => {
    setSavingPreset(true);
    setPresetSaveError(null);
    try {
      const result = await rpc.call('saveFilterPreset', {
        projectId,
        name,
        state: filterStateToPresetState(filters)
      });
      presetsState.setAuthoritative(result.presets);
      setPresetNameDraft(null);
      toast.success(`Saved preset "${result.preset.name}"`);
    } catch (nextError) {
      setPresetSaveError(describeError(nextError));
    } finally {
      setSavingPreset(false);
    }
  };

  const clearFilters = () => setFilters(current => ({ ...defaultFilterState(current.view) }));

  let body: ReactNode;
  if (error) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="AlertCircle" className="size-6 text-destructive" />
        <p role="alert" className="max-w-md text-sm text-muted-foreground">
          {error}
        </p>
        <Button variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  } else if (items === null) {
    body = <LoadingRows />;
  } else if (filteredItems.length === 0) {
    body = (
      <EmptyState
        filtered={items.length > 0}
        onClear={clearFilters}
      />
    );
  } else if (filters.view === 'kanban') {
    body = (
      <KanbanBoard
        items={filteredItems}
        lists={boardLists}
        statusOrder={statusOrder}
        onOpen={onOpen}
        onMove={moveItem}
        canStartThread={canStartThread}
        startThreadPendingId={startThread.pendingId}
        onStartThread={(item, environment) => void startThread.start(item, environment)}
      />
    );
  } else {
    body = (
      <div className="mx-auto w-full max-w-[56rem]">
        <ListStateGroups
          items={filteredItems}
          statusOrder={statusOrder}
          collapsedGroups={filters.collapsedGroups}
          searchActive={filters.query.trim() !== ''}
          onToggleGroup={toggleGroup}
          onMove={moveItem}
          onOpen={onOpen}
          canStartThread={canStartThread}
          startThreadPendingId={startThread.pendingId}
          onStartThread={(item, environment) => void startThread.start(item, environment)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TrackerFilterBar
        presets={presetsState.presets}
        presetsError={presetsState.error}
        presetsRefreshError={presetsState.refreshError}
        presetsLoading={presetsState.loading}
        onApplyPreset={preset => setFilters(presetToFilterState(preset))}
        onRetryPresets={() => void presetsState.reload()}
        onSaveCurrentPreset={() => setPresetNameDraft('')}
        enabledFilters={enabledFilters}
        filters={filters}
        statusOptions={statusOptions}
        assigneeOptions={assigneeOptions}
        labelOptions={labelOptions}
        onFiltersChange={applyFilters}
        onClear={clearFilters}
      />
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>

      <Dialog
        open={presetNameDraft !== null}
        onOpenChange={open => {
          if (!open && !savingPreset) {
            setPresetNameDraft(null);
            setPresetSaveError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save filter preset</DialogTitle>
            <DialogDescription>
              Save the current filters, search, layout, and collapsed groups for this project.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={event => {
              event.preventDefault();
              const name = (presetNameDraft ?? '').trim();
              if (name) void saveCurrentPreset(name);
            }}
            className="flex flex-col gap-3"
          >
            <Input
              autoFocus
              value={presetNameDraft ?? ''}
              disabled={savingPreset}
              onChange={event => setPresetNameDraft(event.target.value)}
              placeholder="My work"
              maxLength={FILTER_PRESET_NAME_MAX_LENGTH}
              aria-label="Preset name"
            />
            {presetSaveError ? (
              <p role="alert" className="text-sm text-destructive">
                {presetSaveError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={savingPreset}
                onClick={() => {
                  setPresetNameDraft(null);
                  setPresetSaveError(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={savingPreset || !(presetNameDraft ?? '').trim()}>
                {savingPreset ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function CommentForm({
  pending,
  onSubmit
}: {
  pending: boolean;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  return (
    <form
      className="mt-4 space-y-2"
      onSubmit={event => {
        event.preventDefault();
        const trimmed = body.trim();
        if (!trimmed || pending) return;
        void onSubmit(trimmed).then(() => setBody(''));
      }}
    >
      <Textarea
        value={body}
        onChange={event => setBody(event.target.value)}
        placeholder="Write a comment… (markdown supported)"
        rows={3}
        maxLength={50_000}
        disabled={pending}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending || body.trim() === ''}>
          {pending ? 'Posting…' : 'Comment'}
        </Button>
      </div>
    </form>
  );
}

function TrackerDetail({
  route,
  refreshGeneration
}: {
  route: Extract<TrackerRoute, { kind: 'item' }>;
  refreshGeneration: number;
}) {
  const rpc = useRpc<TrelloRpcContract>();
  const navigate = useBbNavigate();
  const [item, setItem] = useState<WorkItemDetail | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [postingComment, setPostingComment] = useState(false);
  const [canStartThread, setCanStartThread] = useState(false);
  const startThread = useStartThread();
  const requestRevisionRef = useRef(0);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [savingContent, setSavingContent] = useState(false);

  const load = useCallback(async () => {
    const requestRevision = ++requestRevisionRef.current;
    setError(null);
    try {
      const result = await rpc.call('getItem', {
        projectId: route.projectId,
        locator: route.locator
      });
      if (requestRevision !== requestRevisionRef.current) return;
      setItem(result.item);
    } catch (nextError) {
      if (requestRevision !== requestRevisionRef.current) return;
      setItem(null);
      setError(describeError(nextError));
    }
  }, [rpc, route.projectId, route.locator]);

  useEffect(() => {
    setItem(undefined);
    void load();
    return () => {
      requestRevisionRef.current += 1;
    };
  }, [load, refreshGeneration]);
  useRealtime(ITEMS_CHANGED, payload => {
    const changed = changedProjectId(payload);
    if (changed === null || changed === route.projectId) void load();
  });
  useRefreshOnReconnect(() => void load());

  useEffect(() => {
    let active = true;
    void rpc
      .call('getCreateTaskContext', { projectId: route.projectId })
      .then(result => {
        if (active) setCanStartThread(result.context.available);
      })
      .catch(() => {
        if (active) setCanStartThread(false);
      });
    return () => {
      active = false;
    };
  }, [rpc, route.projectId]);

  const moveItemStatus = useCallback(
    async (_selectedItem: WorkItem, option: WorkStatusOption) => {
      if (!item) throw new Error('The task is not loaded.');
      const previous = item;
      setItem({ ...item, status: option.name, stateCategory: option.stateCategory });
      try {
        const result = await rpc.call('updateItemStatus', {
          projectId: route.projectId,
          locator: route.locator,
          statusId: option.id
        });
        setItem(current => (current ? { ...current, ...result.item, comments: current.comments } : current));
      } catch (nextError) {
        setItem(previous);
        throw nextError;
      }
    },
    [item, route.locator, route.projectId, rpc]
  );

  const changeAssignee = useCallback(
    async (assigneeId: string | null) => {
      if (!item) return;
      const previous = item;
      try {
        const result = await rpc.call('updateItemAssignee', {
          projectId: route.projectId,
          locator: route.locator,
          assigneeId
        });
        setItem(current => (current ? { ...current, ...result.item, comments: current.comments } : current));
        toast.success(`${result.item.key} reassigned`);
      } catch (nextError) {
        setItem(previous);
        toast.error('Could not reassign', { description: describeError(nextError) });
      }
    },
    [item, route.locator, route.projectId, rpc]
  );

  const startEditing = useCallback(() => {
    if (!item) return;
    setEditTitle(item.title);
    setEditDescription(item.description);
    setEditing(true);
  }, [item]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
  }, []);

  const saveContent = useCallback(async () => {
    if (!item) return;
    const trimmedTitle = editTitle.trim();
    // A task must keep a title. Say so and stay in the editor rather than
    // quietly dropping the change, which reads as "Save did nothing".
    if (trimmedTitle === '') {
      toast.error('A task needs a title', {
        description: 'Enter a title, or cancel to keep the current one.'
      });
      return;
    }
    const titleChanged = trimmedTitle !== item.title;
    const descriptionChanged = editDescription !== item.description;
    if (!titleChanged && !descriptionChanged) {
      setEditing(false);
      return;
    }
    setSavingContent(true);
    try {
      const result = await rpc.call('updateItemContent', {
        projectId: route.projectId,
        locator: route.locator,
        ...(titleChanged ? { title: trimmedTitle } : {}),
        ...(descriptionChanged ? { description: editDescription } : {})
      });
      setItem(result.item);
      setEditing(false);
    } catch (nextError) {
      toast.error(`Could not update ${item.key}`, { description: describeError(nextError) });
    } finally {
      setSavingContent(false);
    }
  }, [editDescription, editTitle, item, route.locator, route.projectId, rpc]);

  const addComment = useCallback(
    async (body: string) => {
      setPostingComment(true);
      try {
        const result = await rpc.call('addComment', {
          projectId: route.projectId,
          locator: route.locator,
          body
        });
        setItem(result.item);
      } catch (nextError) {
        toast.error('Could not post comment', { description: describeError(nextError) });
      } finally {
        setPostingComment(false);
      }
    },
    [route.locator, route.projectId, rpc]
  );

  if (item === undefined) {
    return (
      <div className="space-y-4 p-4 md:p-5">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }

  if (item === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="AlertCircle" className="size-6 text-destructive" />
        <p className="text-sm font-medium">Could not load this task</p>
        <p role="alert" className="max-w-md text-sm text-muted-foreground">
          {error}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setItem(undefined);
            void load();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }


  return (
    <div className="@container flex min-h-full flex-col">
      <div className="tb-detail-frame flex flex-1 items-stretch">
        <article className="mx-auto w-full min-w-0 max-w-[52rem] flex-1 px-5 pb-16 pt-7 @3xl:px-10 @3xl:pt-10">
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium tabular-nums">{item.key}</span>
            <WorkItemStatusMenu item={item} variant="detail" onMove={moveItemStatus} />
            <WorkItemAssigneeMenu item={item} onChange={changeAssignee} />
            {!editing ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
                disabled={!canStartThread}
                onClick={startEditing}
              >
                <Icon name="Edit" className="size-3.5" />
                Edit
              </Button>
            ) : null}
            <div className="inline-flex items-center overflow-hidden rounded-full border border-transparent">
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1.5 rounded-r-none rounded-l-full px-2.5 text-xs"
                disabled={!canStartThread || startThread.pendingId !== null}
                onClick={() => void startThread.start(item)}
              >
                <Icon
                  name={startThread.pendingId ? 'Loading' : 'MessageSquarePlus'}
                  className={cn('size-3.5', startThread.pendingId && 'animate-spin')}
                />
                {startThread.pendingId ? 'Starting agent…' : 'Start agent'}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    aria-label="Start agent in a new worktree"
                    className="h-7 w-7 shrink-0 rounded-l-none rounded-r-full border-l border-primary-foreground/20 px-0"
                    disabled={!canStartThread || startThread.pendingId !== null}
                    onClick={() => void startThread.start(item, 'worktree')}
                  >
                    <Icon name="GitBranch" className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-56 text-xs">
                  Start agent in a new worktree — gives this ticket its own checkout so
                  parallel tickets don't collide.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          {item.board ? (
            <p className="mb-1 truncate text-xs text-muted-foreground">{item.board}</p>
          ) : null}
          <div className="flex flex-col gap-4 @lg:flex-row @lg:items-start">
            {editing ? (
              <Input
                value={editTitle}
                onChange={event => setEditTitle(event.target.value)}
                maxLength={500}
                disabled={savingContent}
                className="min-w-0 flex-1 text-2xl font-semibold leading-tight"
                aria-label="Title"
              />
            ) : (
              <h1 className="min-w-0 flex-1 text-2xl font-semibold leading-tight">{item.title}</h1>
            )}
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={item.url} target="_blank" rel="noreferrer">
                  <Icon name="ExternalLink" className="size-3.5" />
                  Open
                </a>
              </Button>
            </div>
          </div>

          <dl className="tb-detail-meta mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-y py-4 @[45rem]:hidden">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Board</dt>
              <dd className="truncate text-sm font-medium">{item.board ?? 'None'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">List</dt>
              <dd className="truncate text-sm font-medium">{item.status}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Due</dt>
              <dd className="truncate text-sm font-medium">{item.dueDate ?? 'None'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Updated</dt>
              <dd className="truncate text-sm font-medium">{formatUpdatedAt(item.updatedAt)}</dd>
            </div>
          </dl>

          {item.labels.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-1.5">
              {item.labels.map(label => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
            </div>
          ) : null}

          <section className="mt-7">
            <h2 className="mb-3 text-sm font-semibold">Description</h2>
            {editing ? (
              <div className="space-y-2">
                <Textarea
                  value={editDescription}
                  onChange={event => setEditDescription(event.target.value)}
                  placeholder="Markdown supported"
                  rows={10}
                  maxLength={100_000}
                  disabled={savingContent}
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={savingContent} onClick={cancelEditing}>
                    Cancel
                  </Button>
                  <Button type="button" size="sm" disabled={savingContent} onClick={() => void saveContent()}>
                    {savingContent ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : item.description.trim() ? (
              <Markdown content={item.description} />
            ) : (
              <p className="text-sm text-muted-foreground">No description provided.</p>
            )}
          </section>

          {item.attachments.length > 0 ? (
            <section className="mt-7">
              <h2 className="mb-3 text-sm font-semibold">
                Attachments <span className="text-muted-foreground">{item.attachments.length}</span>
              </h2>
              <AttachmentList attachments={item.attachments} onOpen={navigate.openUrl} />
              <p className="mt-2 text-xs text-muted-foreground">
                Attachments open in Trello in your browser — the files sit behind your Trello
                session, so this plugin never previews them inline.
              </p>
            </section>
          ) : null}

          <section className="tb-comment-rail mt-8 border-t pt-5">
            <h2 className="mb-1 text-sm font-semibold">
              Comments <span className="text-muted-foreground">{item.comments.length}</span>
            </h2>
            {item.comments.length > 0 ? (
              <div className="ml-2">
                {item.comments.map((comment, index) => (
                  <article
                    key={`${comment.author}:${comment.createdAt}:${index}`}
                    className="tb-comment-entry relative py-4 pl-6"
                  >
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{comment.author}</span>
                      <time>{formatUpdatedAt(comment.createdAt)}</time>
                    </div>
                    <Markdown content={comment.body} />
                    {comment.attachments.length > 0 ? (
                      <div className="mt-2">
                        <AttachmentList attachments={comment.attachments} onOpen={navigate.openUrl} />
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}
            <CommentForm pending={postingComment} onSubmit={addComment} />
          </section>
        </article>

        <aside className="hidden w-56 shrink-0 border-l border-border-hairline py-10 pl-4 pr-6 @[45rem]:block">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-3">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Board</dt>
              <dd className="truncate text-sm font-medium">{item.board ?? 'None'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">List</dt>
              <dd className="truncate text-sm font-medium">{item.status}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Due</dt>
              <dd className="truncate text-sm font-medium">{item.dueDate ?? 'None'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Updated</dt>
              <dd className="truncate text-sm font-medium">{formatUpdatedAt(item.updatedAt)}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create task dialog + composer action
// ---------------------------------------------------------------------------

interface CreatedTaskResult {
  item: WorkItem;
  warnings: string[];
  mention: { provider: 'trello-card'; id: string; label: string };
}

function IssuePropertySelect({
  icon,
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  icon: IconName;
  label: string;
  value: string | null;
  options: readonly CreateTaskOption[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const current = options.find(option => option.id === value)?.label ?? label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-lg bg-background px-2.5 text-xs font-medium shadow-none"
          disabled={disabled}
          aria-label={`${label}: ${current}`}
        >
          <Icon name={icon} className="size-3.5 text-muted-foreground" />
          <span className={cn(!value && 'text-muted-foreground')}>{current}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-56 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="text-muted-foreground">No {label.toLowerCase()}</span>
          {value === null ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
        </DropdownMenuItem>
        {options.map(option => (
          <DropdownMenuItem key={option.id} onSelect={() => onChange(option.id)}>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {value === option.id ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type CreateTaskDialogProps = {
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: CreatedTaskResult) => void;
} & ({ mode: 'direct' } | { mode: 'composer-assisted'; initialPrompt: string });

function CreateTaskDialog(props: CreateTaskDialogProps) {
  const { projectId, open, onOpenChange, onCreated } = props;
  const assisted = props.mode === 'composer-assisted';
  const initialPrompt = assisted ? props.initialPrompt : '';
  const rpc = useRpc<TrelloRpcContract>();
  const navigate = useBbNavigate();
  const formId = useId();
  const [context, setContext] = useState<CreateTaskContext>();
  const [contextError, setContextError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [metadata, setMetadata] = useState<CreateTaskMetadata>();
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [loadedConnectorRevision, setLoadedConnectorRevision] = useState<number | null>(null);
  const [statusId, setStatusId] = useState<string | null>(null);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setContext(undefined);
    setContextError(null);
    setTitle(assisted ? initialPrompt.slice(0, 500) : '');
    setDescription('');
    setMetadata(undefined);
    setMetadataLoading(false);
    setMetadataError(null);
    setLoadedConnectorRevision(null);
    setStatusId(null);
    setAssigneeId(null);
    setDueDate('');
    setCreating(false);
    setCreateError(null);
    if (!projectId) {
      setContextError('Choose a BB project before creating a task.');
      return;
    }
    let active = true;
    void rpc
      .call('getCreateTaskContext', { projectId })
      .then(result => {
        if (!active) return;
        setContext(result.context);
      })
      .catch(error => {
        if (active) setContextError(describeError(error));
      });
    return () => {
      active = false;
    };
  }, [assisted, initialPrompt, open, projectId, rpc]);

  useEffect(() => {
    if (!open || !projectId || context?.available !== true) return;
    let active = true;
    setMetadataLoading(true);
    void rpc
      .call('getCreateTaskMetadata', { projectId })
      .then(result => {
        if (!active) return;
        if (!result.ok) {
          setMetadataError(result.error.safeMessage);
          return;
        }
        setMetadata(result.metadata);
        setLoadedConnectorRevision(result.connectorRevision);
        setStatusId(result.metadata.defaultStatusId);
      })
      .catch(() => {
        if (active) setMetadataError(CREATE_METADATA_NETWORK_ERROR);
      })
      .finally(() => {
        if (active) setMetadataLoading(false);
      });
    return () => {
      active = false;
    };
  }, [context, open, projectId, rpc]);

  const closeDialog = () => onOpenChange(false);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !projectId ||
      !context?.available ||
      creating ||
      metadataLoading ||
      loadedConnectorRevision === null ||
      statusId === null
    ) {
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const input: CreateTaskInput = {
        projectId,
        connectorRevision: loadedConnectorRevision,
        title,
        description,
        statusId,
        assigneeId,
        dueDate: dueDate || null
      };
      const result = await rpc.call('createTask', input);
      onCreated?.(result);
      toast.success(`${result.item.key} created`);
      if (result.warnings.length > 0) toast.warning(result.warnings.join(' '));
      onOpenChange(false);
    } catch (error) {
      setCreateError(describeError(error));
    } finally {
      setCreating(false);
    }
  };

  const canSubmit =
    context?.available === true &&
    !metadataLoading &&
    loadedConnectorRevision !== null &&
    // Trello has nowhere to put a card that is not in a list.
    statusId !== null &&
    title.trim() !== '';

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!creating) {
          if (nextOpen) onOpenChange(true);
          else closeDialog();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {context ? `${context.projectName} · Trello · New card` : 'Prepare card'}
          </DialogTitle>
          <DialogDescription>
            {context === undefined
              ? 'Loading the Trello board configured for this BB project…'
              : !context.available
                ? 'Finish setting up Trello for this project.'
                : !assisted
                  ? `Create a card directly on the Trello board mapped to ${context.projectName}.`
                  : 'Review and edit your composer prompt before creating the card.'}
          </DialogDescription>
        </DialogHeader>

        {contextError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p role="alert" className="text-sm text-destructive">
              {contextError}
            </p>
          </div>
        ) : context === undefined ? (
          <div className="space-y-3 py-1">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : !context.available ? (
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <p role="alert" className="text-sm text-muted-foreground">
              {context.message ?? 'Trello is not ready.'}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                closeDialog();
                navigate.toPluginPanel(PANEL_PATH, {
                  subPath: routeToSubPath({ kind: 'manage', projectId: context.projectId })
                });
              }}
            >
              <Icon name="Settings" className="size-4" />
              Manage Trello
            </Button>
          </div>
        ) : (
          <form id={formId} className="grid gap-4" onSubmit={create}>
            {assisted ? (
              <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-recessed-solid p-3">
                <Icon name="ListTodo" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">Using your composer prompt</p>
                  <p className="text-xs text-muted-foreground">
                    Review and edit the title and description below.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <label htmlFor={`${formId}-title`} className="text-xs font-semibold">
                Title
              </label>
              <Input
                id={`${formId}-title`}
                value={title}
                autoFocus
                maxLength={500}
                placeholder="What needs to be done?"
                disabled={creating}
                onChange={event => {
                  setTitle(event.target.value);
                  setCreateError(null);
                }}
              />
            </div>

            <div className="grid gap-1.5">
              <label htmlFor={`${formId}-description`} className="text-xs font-semibold">
                Description
              </label>
              <Textarea
                id={`${formId}-description`}
                value={description}
                rows={7}
                maxLength={100_000}
                placeholder="Add context, acceptance criteria, or links…"
                disabled={creating}
                onChange={event => {
                  setDescription(event.target.value);
                  setCreateError(null);
                }}
              />
            </div>

            <div className="grid gap-1.5">
              <label htmlFor={`${formId}-due`} className="text-xs font-semibold">
                Due date
              </label>
              <Input
                id={`${formId}-due`}
                type="date"
                value={dueDate}
                disabled={creating}
                onChange={event => setDueDate(event.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 border-t border-border-hairline pt-3">
              {metadataLoading ? (
                <>
                  <Skeleton className="h-8 w-20 rounded-lg" />
                  <Skeleton className="h-8 w-24 rounded-lg" />
                  <Skeleton className="h-8 w-20 rounded-lg" />
                </>
              ) : metadataError ? (
                <p className="text-xs text-destructive">{metadataError}</p>
              ) : metadata ? (
                <>
                  <IssuePropertySelect
                    icon="Columns2"
                    label="List"
                    value={statusId}
                    options={metadata.statusOptions}
                    onChange={setStatusId}
                    disabled={creating}
                  />
                  <IssuePropertySelect
                    icon="UserRound"
                    label="Member"
                    value={assigneeId}
                    options={metadata.assigneeOptions}
                    onChange={setAssigneeId}
                    disabled={creating}
                  />
                </>
              ) : null}
            </div>

            {createError ? (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            ) : null}
          </form>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={creating} onClick={closeDialog}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!canSubmit || creating}>
            {creating ? 'Creating…' : 'Create task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DirectCreateTaskAction({ projectId }: { projectId: string | null }) {
  const [launchProjectId, setLaunchProjectId] = useState<string | null>(null);
  const label = projectId ? 'Create a new Trello card' : 'Choose a BB project before creating a card';
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={label}
        disabled={!projectId}
        onClick={() => {
          if (projectId) setLaunchProjectId(projectId);
        }}
      >
        <Icon name="Ticket" className="size-4" />
        New task
      </Button>
      {launchProjectId ? (
        <CreateTaskDialog
          mode="direct"
          projectId={launchProjectId}
          open={launchProjectId !== null}
          onOpenChange={nextOpen => {
            if (!nextOpen) setLaunchProjectId(null);
          }}
        />
      ) : null}
    </>
  );
}

function ComposerCreateTaskAction() {
  const { values } = useSettings();

  // Returning no component removes the action from the composer entirely;
  // it is not merely an unavailable button. Undefined is treated as enabled
  // so the default remains backward-compatible while settings load.
  if (values?.composerCardActionEnabled === false) return null;

  return <EnabledComposerCreateTaskAction />;
}

function EnabledComposerCreateTaskAction() {
  const view = useComposerView();
  const composer = useComposer();
  const { projectId: contextProjectId } = useBbContext();
  const [open, setOpen] = useState(false);
  const [draftSession, setDraftSession] = useState<{ projectId: string; prompt: string } | null>(null);
  const projectId =
    view.scope.kind === 'new-thread' ? (view.scope.projectId ?? contextProjectId) : contextProjectId;
  const hasPrompt = view.draft.text.trim().length > 0;
  const guidance = !projectId
    ? 'Choose a project to create a task'
    : !hasPrompt
      ? 'Write a prompt to create a task'
      : 'Turn prompt into a Trello card';

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 bg-transparent text-foreground hover:bg-state-hover"
                aria-label="Create Trello card"
                disabled={!projectId || !hasPrompt || view.run.isSubmitting}
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  if (!projectId) {
                    toast.error('Choose a BB project before creating a task.');
                    return;
                  }
                  if (!hasPrompt) {
                    toast.info('Write a prompt first, then click the Trello ticket.');
                    composer.focus();
                    return;
                  }
                  setDraftSession({ projectId, prompt: view.draft.text });
                  setOpen(true);
                }}
              >
                <Icon name="Ticket" className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{guidance}</TooltipContent>
        </Tooltip>
        {draftSession ? (
          <CreateTaskDialog
            mode="composer-assisted"
            projectId={draftSession.projectId}
            open={open}
            onOpenChange={setOpen}
            initialPrompt={draftSession.prompt}
            onCreated={result => {
              composer.insertMention(result.mention);
              composer.focus();
            }}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Manage view: org connection + per-project mapping
// ---------------------------------------------------------------------------

function secretMutation(value: string, remove: boolean): SecretMutation {
  if (value.trim()) return { operation: 'set', value: value.trim() };
  return remove ? { operation: 'clear' } : { operation: 'keep' };
}

function CredentialStatus({
  configured,
  hasDraft,
  remove,
  rejected = false
}: {
  configured: boolean;
  hasDraft: boolean;
  remove: boolean;
  /** Trello's 401 named THIS credential — not merely "one of the two". */
  rejected?: boolean;
}) {
  const label = remove
    ? 'Removal queued'
    : hasDraft
      ? configured
        ? 'Replacement ready'
        : 'Ready'
      : rejected
        ? 'Rejected by Trello'
        : configured
          ? 'Configured'
          : 'Not configured';
  const tone = rejected && !remove && !hasDraft
    ? 'border-destructive/30 bg-destructive/10 text-destructive'
    : configured && !remove
      ? 'border-success/30 bg-success/10 text-success'
      : 'text-muted-foreground';
  const dot = rejected && !remove && !hasDraft
    ? 'bg-destructive'
    : configured && !remove
      ? 'bg-success'
      : 'bg-muted-foreground/60';
  return (
    <span
      className={cn(
        'tb-status-pill inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        tone
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />
      {label}
    </span>
  );
}

/**
 * The connection form body, shared between the settings-section entry point
 * (direct `saveConnection` RPC) and the `trello-connection` pending
 * interaction (server-triggered `bb.ui.requestInput`, submit/cancel props).
 *
 * Both fields are write-only: neither ever echoes a configured credential
 * back, only whether one is configured. The API key is treated as a secret
 * alongside the token because Trello sends both as query parameters, so a
 * leaked key is as good as a leaked header.
 */
function ConnectionForm({
  keyConfigured,
  tokenConfigured,
  invalidCredential = null,
  busy,
  error,
  onSubmit,
  onCancel
}: {
  keyConfigured: boolean;
  tokenConfigured: boolean;
  /** Which half Trello rejected, so the badge lands on the right field. */
  invalidCredential?: 'key' | 'token' | null;
  busy: boolean;
  error: string | null;
  onSubmit: (mutation: ConnectionMutation) => void;
  onCancel?: () => void;
}) {
  const formId = useId();
  const [keyDraft, setKeyDraft] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [removeToken, setRemoveToken] = useState(false);

  const credentialField = (
    id: string,
    label: string,
    placeholder: string,
    draft: string,
    setDraft: (value: string) => void,
    configured: boolean,
    remove: boolean,
    setRemove: (update: (value: boolean) => boolean) => void,
    rejected: boolean
  ) => (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-semibold">
          {label}
        </label>
        <CredentialStatus
          configured={configured}
          hasDraft={draft.trim() !== ''}
          remove={remove}
          rejected={rejected}
        />
      </div>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={draft}
        placeholder={configured ? `Enter to replace the current ${label.toLowerCase()}` : placeholder}
        disabled={busy || remove}
        onChange={event => setDraft(event.target.value)}
      />
      {configured ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => {
            setRemove(value => !value);
            setDraft('');
          }}
        >
          {remove ? `Keep ${label.toLowerCase()}` : `Remove ${label.toLowerCase()}`}
        </Button>
      ) : null}
    </div>
  );

  return (
    <form
      id={formId}
      className="space-y-4"
      onSubmit={event => {
        event.preventDefault();
        onSubmit({
          apiKey: secretMutation(keyDraft, removeKey),
          apiToken: secretMutation(tokenDraft, removeToken)
        });
      }}
    >
      <p className="text-xs text-muted-foreground">
        Only needed if you are not using the Connect button, or if you would rather
        authorise with your own Power-Up. Both come from{' '}
        <a
          href={TRELLO_POWER_UP_ADMIN_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          trello.com/power-ups/admin
        </a>
        : the API key is on the Power-Up's “API key” tab, and that key's “Token” link
        mints a token to paste here.
      </p>

      {credentialField(
        `${formId}-key`,
        'API key',
        'Your Trello API key',
        keyDraft,
        setKeyDraft,
        keyConfigured,
        removeKey,
        setRemoveKey,
        invalidCredential === 'key'
      )}
      {credentialField(
        `${formId}-token`,
        'API token',
        'Your Trello API token',
        tokenDraft,
        setTokenDraft,
        tokenConfigured,
        removeToken,
        setRemoveToken,
        invalidCredential === 'token'
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t border-border-hairline pt-4 sm:flex-row sm:justify-end">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save connection'}
        </Button>
      </div>
    </form>
  );
}

function ConnectionSection() {
  const rpc = useRpc<TrelloRpcContract>();
  const navigate = useBbNavigate();
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  /**
   * One click: the server mints a single-use nonce and returns the Trello
   * authorize URL; the token comes back to a local callback route, never
   * through this component. The panel updates itself from the
   * CONNECTION_CHANGED signal the server publishes once it lands.
   */
  const beginAuth = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { authorizeUrl } = await rpc.call('beginTrelloAuth', null);
      if (!navigate.openUrl(authorizeUrl)) {
        setAuthError('BB could not open a browser for the Trello approval page.');
      }
    } catch (nextError) {
      setAuthError(describeError(nextError));
    } finally {
      setAuthBusy(false);
    }
  }, [navigate, rpc]);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call('getConnection', null);
      setConnection(result.connection);
      setError(null);
    } catch (nextError) {
      setError(describeError(nextError));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(CONNECTION_CHANGED, () => void load());

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-card p-5">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!connection) {
    return (
      <div className="tb-settings-card rounded-xl border p-5">
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="tb-settings-card space-y-4 rounded-xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Trello connection</h3>
        <CredentialStatus
          configured={connection.available}
          hasDraft={false}
          remove={false}
          rejected={connection.invalidCredential !== null}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {connection.configured
          ? connection.available
            ? `Connected to Trello${connection.viewerName ? ` as ${connection.viewerName}` : ''}.`
            : (connection.message ?? 'Connection is not available.')
          : (connection.message ??
            'Connect Trello to authorise this bb install. One connection serves every bb project.')}
      </p>

      {connection.keyConfigured ? (
        <div className="space-y-2">
          <Button
            type="button"
            size="sm"
            disabled={authBusy}
            onClick={() => void beginAuth()}
          >
            {authBusy
              ? 'Opening Trello…'
              : connection.available
                ? 'Reconnect Trello'
                : 'Connect Trello'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Opens Trello in your browser to approve access. Trello only redirects back
            to origins allowlisted on the API key, so{' '}
            <code className="rounded bg-muted px-1 py-0.5">
              {connection.callbackOrigin || 'this bb server’s address'}
            </code>{' '}
            must be listed under “Allowed origins” on that key's tab.
          </p>
          {authError ? (
            <p role="alert" className="text-sm text-destructive">
              {authError}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-sm">
            A Trello API key is needed before this install can connect.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create (or open) a Power-Up on{' '}
            <a
              href={TRELLO_POWER_UP_ADMIN_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              trello.com/power-ups/admin
            </a>
            , copy the key from its “API key” tab, add{' '}
            <code className="rounded bg-muted px-1 py-0.5">
              {connection.callbackOrigin || 'this bb server’s address'}
            </code>{' '}
            to that key's allowed origins, and paste the key below.
          </p>
        </div>
      )}

      <ConnectionForm
        keyConfigured={connection.keyConfigured && !connection.keyIsBundled}
        tokenConfigured={connection.tokenConfigured}
        invalidCredential={connection.invalidCredential}
        busy={busy}
        error={saveError}
        onSubmit={mutation => {
          setBusy(true);
          setSaveError(null);
          void rpc
            .call('saveConnection', mutation)
            .then(result => {
              setConnection(result.connection);
              toast.success('Connection saved');
            })
            .catch(nextError => setSaveError(describeError(nextError)))
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [value, delayMs]);
  return debounced;
}

function ProjectMappingForm({ projectId }: { projectId: string }) {
  const rpc = useRpc<TrelloRpcContract>();
  const [scope, setScope] = useState<ProjectScopeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boardQuery, setBoardQuery] = useState('');
  const debouncedQuery = useDebouncedValue(boardQuery, BOARD_SEARCH_DEBOUNCE_MS);
  const [boardOptions, setBoardOptions] = useState<TrelloBoardOption[]>([]);
  const [searchingBoards, setSearchingBoards] = useState(false);
  const [lists, setLists] = useState<readonly TrelloListOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call('getProjectScope', { projectId });
      setScope(result.scope);
      setError(null);
    } catch (nextError) {
      setError(describeError(nextError));
    }
  }, [projectId, rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;
    setSearchingBoards(true);
    void rpc
      .call('listTrelloBoards', { query: debouncedQuery })
      .then(result => {
        if (active) setBoardOptions(result.boards);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setSearchingBoards(false);
      });
    return () => {
      active = false;
    };
  }, [debouncedQuery, rpc]);

  // The board's lists drive the per-list category overrides below.
  useEffect(() => {
    if (!scope || scope.boardId === '') {
      setLists([]);
      return;
    }
    let active = true;
    void rpc
      .call('listBoardLists', { projectId, boardId: scope.boardId })
      .then(result => {
        if (active) setLists(result.lists);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projectId, rpc, scope?.boardId, scope?.listCategories]);

  const save = (next: ProjectScope) => {
    setSaving(true);
    setSaveError(null);
    void rpc
      .call('saveProjectScope', next)
      .then(result => setScope(result.scope))
      .catch(nextError => setSaveError(describeError(nextError)))
      .finally(() => setSaving(false));
  };

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-card p-5">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    );
  }

  if (!scope) {
    return (
      <div className="tb-settings-card rounded-xl border p-5">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!scope.connectionConfigured) {
    return (
      <div className="tb-settings-card rounded-xl border p-5 text-sm text-muted-foreground">
        Connect Trello above before mapping this project.
      </div>
    );
  }

  const boardName =
    scope.boardName ??
    boardOptions.find(option => option.id === scope.boardId)?.name ??
    null;

  return (
    <div className="tb-settings-card space-y-4 rounded-xl border p-5">
      <h3 className="text-sm font-semibold">Board mapping</h3>

      <div className="grid gap-1.5">
        <span className="text-xs font-semibold">Trello board</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="w-full justify-start gap-1.5">
              <Icon name="Columns2" className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">
                {boardName ?? 'Choose a Trello board'}
              </span>
              <Icon name="ChevronDown" className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[--radix-dropdown-menu-trigger-width] max-h-80 overflow-y-auto p-0"
          >
            <div className="sticky top-0 border-b border-border bg-popover p-2">
              <Input
                autoFocus
                value={boardQuery}
                onChange={event => setBoardQuery(event.target.value)}
                placeholder="Search Trello boards…"
                aria-label="Search Trello boards"
              />
            </div>
            <div className="p-1">
              {searchingBoards ? (
                <DropdownMenuItem disabled>Searching…</DropdownMenuItem>
              ) : boardOptions.length === 0 ? (
                <DropdownMenuItem disabled>No boards found</DropdownMenuItem>
              ) : (
                boardOptions.map(option => (
                  <DropdownMenuItem
                    key={option.id}
                    onSelect={() =>
                      save({
                        projectId,
                        boardId: option.id,
                        assignedToMeOnly: scope.assignedToMeOnly,
                        includeClosed: scope.includeClosed,
                        // Overrides are keyed by list id, so they mean nothing
                        // on a different board.
                        listCategories:
                          option.id === scope.boardId ? scope.listCategories : {}
                      })
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                    {scope.boardId === option.id ? (
                      <Icon name="Check" className="ml-auto size-3.5" />
                    ) : null}
                  </DropdownMenuItem>
                ))
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {scope.boardId !== '' ? (
        <div className="grid gap-1.5">
          <span className="text-xs font-semibold">List states</span>
          <p className="text-xs text-muted-foreground">
            Trello lists carry no state, so each one&apos;s todo / in progress / done bucket is
            guessed from its name. Correct any the guess got wrong — the board tone, the state
            filter and the agent context all follow this.
          </p>
          {lists.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open lists on this board.</p>
          ) : (
            <ul className="divide-y divide-border-hairline">
              {lists.map(list => (
                <li key={list.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <WorkStateGlyph category={list.stateCategory} />
                    <span className="min-w-0 truncate text-sm">{list.name}</span>
                    {list.stateCategory === list.guessedCategory ? null : (
                      <Badge variant="secondary" className="shrink-0">
                        overridden
                      </Badge>
                    )}
                  </span>
                  <Select
                    value={list.stateCategory}
                    disabled={saving}
                    onValueChange={value =>
                      save({
                        projectId,
                        boardId: scope.boardId,
                        assignedToMeOnly: scope.assignedToMeOnly,
                        includeClosed: scope.includeClosed,
                        listCategories: {
                          ...scope.listCategories,
                          [list.id]: value as WorkStateCategory
                        }
                      })
                    }
                  >
                    <SelectTrigger
                      className="w-40 shrink-0"
                      aria-label={`State for list ${list.name}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATE_CATEGORY_ORDER.map(category => (
                        <SelectItem key={category} value={category}>
                          {STATE_CATEGORY_LABELS[category]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              ))}
            </ul>
          )}
          {Object.keys(scope.listCategories).length > 0 ? (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() =>
                  save({
                    projectId,
                    boardId: scope.boardId,
                    assignedToMeOnly: scope.assignedToMeOnly,
                    includeClosed: scope.includeClosed,
                    listCategories: {}
                  })
                }
              >
                Reset to the guessed states
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={scope.assignedToMeOnly}
            disabled={saving}
            onChange={event =>
              save({
                projectId,
                boardId: scope.boardId,
                assignedToMeOnly: event.target.checked,
                includeClosed: scope.includeClosed,
                listCategories: scope.listCategories
              })
            }
          />
          Only show cards I am a member of
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={scope.includeClosed}
            disabled={saving}
            onChange={event =>
              save({
                projectId,
                boardId: scope.boardId,
                assignedToMeOnly: scope.assignedToMeOnly,
                includeClosed: event.target.checked,
                listCategories: scope.listCategories
              })
            }
          />
          Include archived cards
        </label>
      </div>

      {saveError ? (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}

function BoardSettingsForm({ projectId }: { projectId: string }) {
  const rpc = useRpc<TrelloRpcContract>();
  const [settings, setSettings] = useState<ProjectBoardSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettings(null);
    void rpc
      .call('getProjectBoardSettings', { projectId })
      .then(result => setSettings(result.settings))
      .catch(nextError => setError(describeError(nextError)));
  }, [projectId, rpc]);

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-card p-5">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="tb-settings-card rounded-xl border p-5">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const save = (next: ProjectBoardSettings) => {
    setSaving(true);
    void rpc
      .call('saveProjectBoardSettings', next)
      .then(result => setSettings(result.settings))
      .finally(() => setSaving(false));
  };

  return (
    <div className="tb-settings-card space-y-4 rounded-xl border p-5">
      <h3 className="text-sm font-semibold">Board display</h3>
      <div className="grid gap-1.5">
        <span className="text-xs font-semibold">Default view</span>
        <Select
          value={settings.defaultView}
          disabled={saving}
          onValueChange={value => save({ ...settings, defaultView: value as TrackerView })}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="list">List</SelectItem>
            <SelectItem value="kanban">Kanban</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <span className="text-xs font-semibold">Visible filters</span>
        <div className="flex flex-wrap gap-3">
          {ALL_FILTER_FIELDS.map(field => (
            <label key={field} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={settings.enabledFilters.includes(field)}
                disabled={saving}
                onChange={event =>
                  save({
                    ...settings,
                    enabledFilters: event.target.checked
                      ? [...settings.enabledFilters, field]
                      : settings.enabledFilters.filter(value => value !== field)
                  })
                }
              />
              {FILTER_PRESENTATION[field].label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function FilterPresetsForm({ projectId }: { projectId: string }) {
  const rpc = useRpc<TrelloRpcContract>();
  const [presets, setPresets] = useState<readonly FilterPreset[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void rpc
      .call('listFilterPresets', { projectId })
      .then(result => setPresets(result.presets))
      .catch(nextError => setError(describeError(nextError)));
  }, [projectId, rpc]);

  useEffect(() => load(), [load]);
  useRealtime(PRESETS_CHANGED, payload => {
    const changed = changedProjectId(payload);
    if (changed === null || changed === projectId) load();
  });

  return (
    <div className="tb-settings-card space-y-3 rounded-xl border p-5">
      <h3 className="text-sm font-semibold">Filter presets</h3>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : presets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No saved presets yet. Save one from the board&apos;s filter bar.
        </p>
      ) : (
        <ul className="divide-y divide-border-hairline">
          {presets.map(preset => (
            <li key={preset.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{preset.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label={`Delete preset "${preset.name}"`}
                onClick={() => {
                  void rpc
                    .call('deleteFilterPreset', { projectId, id: preset.id })
                    .then(result => setPresets(result.presets));
                }}
              >
                <Icon name="Trash2" className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ManageView({
  projectId,
  projects,
  isLoadingProjects,
  onProjectChange
}: {
  projectId: string | null;
  projects: readonly TrackerProject[] | undefined;
  isLoadingProjects: boolean;
  onProjectChange: (projectId: string) => void;
}) {
  return (
    <div className="h-full overflow-y-auto p-3 @container">
      <div className="mx-auto w-full max-w-4xl space-y-4 pb-8">
        <header className="tb-manage-hero flex flex-col gap-3 rounded-lg border px-4 py-4 @lg:flex-row @lg:items-end @lg:justify-between @lg:px-5">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Project settings
            </p>
            <h2 className="text-lg font-semibold">Trello setup</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              One Trello connection serves every bb project; map this bb project to a
              Trello board below, then correct its list states and choose its layout.
            </p>
          </div>
          {projects && projects.length > 0 ? (
            <Select value={projectId ?? undefined} onValueChange={onProjectChange}>
              <SelectTrigger aria-label="BB project" className="h-9 w-64 max-w-full">
                <SelectValue placeholder="Choose a BB project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map(project => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </header>

        <ConnectionSection />

        {isLoadingProjects || projects === undefined ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : projects.length === 0 || projectId === null ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card p-10 text-center">
            <Icon name="Folder" className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">No BB projects found</p>
          </div>
        ) : (
          <>
            <ProjectMappingForm key={`mapping:${projectId}`} projectId={projectId} />
            <BoardSettingsForm key={`settings:${projectId}`} projectId={projectId} />
            <FilterPresetsForm key={`presets:${projectId}`} projectId={projectId} />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar + topbar + panel shell
// ---------------------------------------------------------------------------

function SidebarRow({
  active = false,
  onClick,
  children
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      data-active={active ? 'true' : 'false'}
      className={cn(
        'tb-sidebar-row flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        active ? 'font-medium text-foreground' : 'hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function TrackerSidebar({
  route,
  projects,
  isLoading,
  onNavigate
}: {
  route: TrackerRoute;
  projects: readonly TrackerProject[] | undefined;
  isLoading: boolean;
  onNavigate: (route: TrackerRoute) => void;
}) {
  const activeProjectId = route.kind === 'project' || route.kind === 'item' ? route.projectId : null;
  const managedProjectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'manage'
        ? route.projectId
        : null;
  return (
    <aside
      aria-label="Trello navigation"
      className="tb-sidebar flex h-full w-52 shrink-0 flex-col border-l"
    >
      <nav aria-label="Trello navigation" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-3">
        <div className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-subtle-foreground">
          Projects
        </div>
        {isLoading ? (
          <div className="space-y-2 px-2 pt-2">
            {['w-3/4', 'w-2/3', 'w-4/5'].map(width => (
              <div className="flex h-7 items-center gap-2" key={width}>
                <Skeleton className="size-3 rounded-sm" />
                <Skeleton className={cn('h-3', width)} />
              </div>
            ))}
          </div>
        ) : projects && projects.length > 0 ? (
          <div className="space-y-px">
            {projects.map(project => (
              <SidebarRow
                key={project.id}
                active={activeProjectId === project.id}
                onClick={() => onNavigate({ kind: 'project', projectId: project.id })}
              >
                <Icon name="Folder" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={project.name}>
                  {project.name}
                </span>
              </SidebarRow>
            ))}
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">No BB projects found.</p>
        )}
      </nav>
      <div className="shrink-0 border-t border-border-hairline px-2 py-1.5">
        <SidebarRow
          active={route.kind === 'manage'}
          onClick={() => onNavigate({ kind: 'manage', projectId: managedProjectId })}
        >
          <Icon name="Settings" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Manage</span>
        </SidebarRow>
      </div>
    </aside>
  );
}

function TrackerTopbar({
  route,
  projects,
  sidebarCollapsed,
  refreshing,
  refreshDisabled,
  onBack,
  onRefresh,
  onToggleSidebar
}: {
  route: TrackerRoute;
  projects: readonly TrackerProject[] | undefined;
  sidebarCollapsed: boolean;
  refreshing: boolean;
  refreshDisabled: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onToggleSidebar: () => void;
}) {
  const projectId = route.kind === 'project' || route.kind === 'item' ? route.projectId : null;
  const project = projects?.find(candidate => candidate.id === projectId);
  const title =
    route.kind === 'manage'
      ? 'Manage'
      : route.kind === 'item'
        ? project?.name ?? 'Task'
        : (project?.name ?? 'Trello');

  return (
    <div className="tb-topbar flex h-11 shrink-0 items-center gap-2 border-b px-2.5">
      {route.kind === 'item' ? (
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Back" onClick={onBack}>
          <Icon name="ChevronLeft" className="size-4" />
        </Button>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      {route.kind === 'project' ? <DirectCreateTaskAction projectId={projectId} /> : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Refresh"
        disabled={refreshDisabled || refreshing}
        onClick={onRefresh}
      >
        <Icon name="ArrowReloadHorizontal" className={cn('size-4', refreshing && 'animate-spin')} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={sidebarCollapsed ? 'Show projects' : 'Hide projects'}
        onClick={onToggleSidebar}
      >
        <Icon name="PanelLeft" className="size-4" />
      </Button>
    </div>
  );
}

function TrelloPanel({ subPath }: PluginNavPanelProps) {
  const route = parseTrackerRoute(subPath);
  const rpc = useRpc<TrelloRpcContract>();
  const navigate = useBbNavigate();
  const { projectId: contextProjectId } = useBbContext();
  const [projects, setProjects] = useState<TrackerProject[] | undefined>();
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const projectsRequestRevisionRef = useRef(0);
  const lastBrowseRouteRef = useRef<Extract<TrackerRoute, { kind: 'project' }> | null>(null);

  const loadProjects = useCallback(async () => {
    const requestRevision = ++projectsRequestRevisionRef.current;
    setProjectsError(null);
    try {
      const result = await rpc.call('listProjects', null);
      if (requestRevision !== projectsRequestRevisionRef.current) return;
      setProjects(result.projects);
    } catch (nextError) {
      if (requestRevision !== projectsRequestRevisionRef.current) return;
      setProjects([]);
      setProjectsError(describeError(nextError));
    }
  }, [rpc]);
  useEffect(() => {
    void loadProjects();
    return () => {
      projectsRequestRevisionRef.current += 1;
    };
  }, [loadProjects]);
  useRefreshOnReconnect(() => void loadProjects());

  useEffect(() => {
    if (route.kind === 'project') {
      lastBrowseRouteRef.current = route;
      storeLastProjectId(route.projectId);
    }
    // Remember browse and item routes, never 'root' (which is the thing we
    // are trying to redirect away from) or 'manage' (reopening into a settings
    // form is not where anyone left off).
    if (route.kind === 'project' || route.kind === 'item') {
      storeLastRoute(routeToSubPath(route));
      if (route.kind === 'item') storeLastProjectId(route.projectId);
    }
  }, [route]);

  const preferredProjectId = useMemo(() => {
    if (!projects || projects.length === 0) return null;
    if (contextProjectId && projects.some(project => project.id === contextProjectId)) {
      return contextProjectId;
    }
    const lastProjectId = loadLastProjectId();
    if (lastProjectId && projects.some(project => project.id === lastProjectId)) return lastProjectId;
    return projects[0]?.id ?? null;
  }, [contextProjectId, projects]);

  useEffect(() => {
    if (route.kind !== 'root' || preferredProjectId === null) return;
    // Restore where the user left off, but only if that project still exists
    // and the app has not put us in a different project's context.
    const restored = parseTrackerRoute(loadLastRoute() ?? '');
    const restorable =
      (restored.kind === 'item' || restored.kind === 'project') &&
      (projects ?? []).some(project => project.id === restored.projectId) &&
      (contextProjectId === null || contextProjectId === restored.projectId);
    navigate.toPluginPanel(PANEL_PATH, {
      subPath: restorable
        ? routeToSubPath(restored)
        : routeToSubPath({ kind: 'project', projectId: preferredProjectId }),
      replace: true
    });
  }, [contextProjectId, navigate, preferredProjectId, projects, route.kind]);

  const go = (nextRoute: TrackerRoute) =>
    navigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(nextRoute) });
  const backFromItem = () => {
    if (route.kind !== 'item') return;
    go(lastBrowseRouteRef.current ?? { kind: 'project', projectId: route.projectId });
  };
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const projectIds =
        route.kind === 'project' || route.kind === 'item'
          ? [route.projectId]
          : (projects ?? []).map(project => project.id);
      await Promise.all(projectIds.map(projectId => rpc.call('refresh', { projectId })));
      setRefreshGeneration(generation => generation + 1);
    } catch (nextError) {
      toast.error('Refresh failed', { description: describeError(nextError) });
    } finally {
      setRefreshing(false);
    }
  };

  let outlet: ReactNode;
  if (route.kind === 'manage') {
    outlet = (
      <ManageView
        projectId={route.projectId ?? preferredProjectId}
        projects={projects}
        isLoadingProjects={projects === undefined}
        onProjectChange={projectId => go({ kind: 'manage', projectId })}
      />
    );
  } else if (route.kind === 'item') {
    outlet = <TrackerDetail route={route} refreshGeneration={refreshGeneration} />;
  } else if (route.kind === 'project') {
    outlet = (
      <TrackerBoard
        key={route.projectId}
        projectId={route.projectId}
        refreshGeneration={refreshGeneration}
        onOpen={item => go({ kind: 'item', projectId: item.bbProjectId, locator: item.locator })}
      />
    );
  } else {
    outlet =
      projects === undefined ? (
        <LoadingRows />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <Icon name="Folder" className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No BB projects found.</p>
        </div>
      );
  }

  return (
    <div className="tb-linear relative flex h-full min-h-0 flex-row-reverse text-foreground">
      {!sidebarCollapsed ? (
        <TrackerSidebar
          route={route}
          projects={projects}
          isLoading={projects === undefined}
          onNavigate={go}
        />
      ) : null}
      <main className="@container flex min-w-0 flex-1 flex-col">
        <TrackerTopbar
          route={route}
          projects={projects}
          sidebarCollapsed={sidebarCollapsed}
          refreshing={refreshing}
          refreshDisabled={route.kind === 'manage'}
          onBack={backFromItem}
          onRefresh={() => void refresh()}
          onToggleSidebar={() => {
            const next = !sidebarCollapsed;
            setSidebarCollapsed(next);
            storeSidebarCollapsed(next);
          }}
        />
        {projectsError ? (
          <p role="alert" className="shrink-0 border-b border-border-hairline px-3.5 py-1.5 text-xs text-destructive">
            {projectsError}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto">{outlet}</div>
      </main>
    </div>
  );
}

function TrelloHeaderAction({ subPath }: PluginNavPanelProps) {
  const route = parseTrackerRoute(subPath);
  const { projectId: contextProjectId } = useBbContext();
  const navigate = useBbNavigate();
  const routeProjectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'manage'
        ? route.projectId
        : null;
  const projectId = routeProjectId ?? contextProjectId ?? loadLastProjectId();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() =>
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: projectId ? routeToSubPath({ kind: 'manage', projectId }) : 'manage'
        })
      }
    >
      <Icon name="Settings" className="size-4" />
      Manage
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Thread panels
// ---------------------------------------------------------------------------

function TrelloRightPanel({ projectId }: { projectId: string | null | undefined }) {
  const navigate = useBbNavigate();
  const [itemRoute, setItemRoute] = useState<Extract<TrackerRoute, { kind: 'item' }> | null>(null);
  const [refreshGeneration] = useState(0);

  if (projectId === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Skeleton className="h-8 w-32" />
      </div>
    );
  }
  if (projectId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
        <Icon name="Ticket" className="size-5" />
        No bb project is associated with this thread yet.
      </div>
    );
  }

  return (
    <div className="tb-linear flex h-full min-h-0 flex-col text-foreground">
      {itemRoute ? (
        <>
          <div className="tb-topbar flex h-11 shrink-0 items-center gap-2 border-b px-2.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Back"
              onClick={() => setItemRoute(null)}
            >
              <Icon name="ChevronLeft" className="size-4" />
            </Button>
            <span className="text-sm font-medium">Task</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <TrackerDetail route={itemRoute} refreshGeneration={refreshGeneration} />
          </div>
        </>
      ) : (
        <>
          <div className="tb-topbar flex h-11 shrink-0 items-center justify-between gap-2 border-b px-2.5">
            <span className="text-sm font-medium">Trello</span>
            <div className="flex items-center gap-1.5">
              <DirectCreateTaskAction projectId={projectId} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Open full board"
                onClick={() =>
                  navigate.toPluginPanel(PANEL_PATH, {
                    subPath: routeToSubPath({ kind: 'project', projectId })
                  })
                }
              >
                <Icon name="ExternalLink" className="size-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <TrackerBoard
              projectId={projectId}
              refreshGeneration={refreshGeneration}
              onOpen={item => setItemRoute({ kind: 'item', projectId: item.bbProjectId, locator: item.locator })}
            />
          </div>
        </>
      )}
    </div>
  );
}

function TrelloThreadPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<TrelloRpcContract>();
  const { projectId: contextProjectId, threadId: contextThreadId } = useBbContext();
  const fallbackProjectId = contextThreadId === threadId ? contextProjectId : null;
  const [projectId, setProjectId] = useState<string | null | undefined>();

  useEffect(() => {
    let cancelled = false;
    setProjectId(undefined);
    void rpc
      .call('threadProject', { threadId })
      .then(result => {
        if (!cancelled) setProjectId(result.projectId);
      })
      .catch(nextError => {
        if (cancelled) return;
        setProjectId(fallbackProjectId);
        toast.error('Could not resolve this thread’s Trello board.', {
          description: describeError(nextError)
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fallbackProjectId, rpc, threadId]);

  return <TrelloRightPanel projectId={projectId} />;
}

function TrelloNewThreadPanel({ projectId }: PluginNewThreadPanelProps) {
  return <TrelloRightPanel projectId={projectId} />;
}

function TrelloThreadHeaderAction({ threadId }: PluginThreadHeaderActionProps) {
  const { openThreadPanel } = useBbNavigate();
  const autoOpenedThreadRef = useRef<string | null>(null);
  const openPanel = useCallback(
    (showError: boolean) => {
      const opened = openThreadPanel({ actionId: THREAD_PANEL_ACTION_ID, title: 'Trello' });
      if (!opened && showError) toast.error('Trello cannot open beside this thread.');
      return opened;
    },
    [openThreadPanel]
  );

  useEffect(() => {
    if (!loadRightPanelPinned() || autoOpenedThreadRef.current === threadId) return;
    autoOpenedThreadRef.current = threadId;
    const timeout = window.setTimeout(() => openPanel(false), 0);
    return () => window.clearTimeout(timeout);
  }, [openPanel, threadId]);

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Pin Trello on the right"
            onClick={() => {
              storeRightPanelPinned(true);
              openPanel(true);
            }}
          >
            <Icon name="Ticket" className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Pin Trello on the right</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Pending interaction: the connection form server.ts opens with
// bb.ui.requestInput({ rendererId: 'trello-connection', payload })
// ---------------------------------------------------------------------------

function TrelloConnectionInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => connectionInteractionPayloadSchema.safeParse(interaction.payload),
    [interaction.payload]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!parsed.success) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-muted-foreground">
          This connection request is invalid.
        </p>
        <Button type="button" variant="outline" onClick={() => void cancel().catch(() => undefined)}>
          Cancel
        </Button>
      </div>
    );
  }
  const payload = parsed.data;

  return (
    <ConnectionForm
      keyConfigured={payload.keyConfigured}
      tokenConfigured={payload.tokenConfigured}
      busy={busy}
      error={error}
      onCancel={() => void cancel().catch(() => undefined)}
      onSubmit={mutation => {
        const validated = connectionInteractionResponseSchema.safeParse(mutation);
        if (!validated.success) {
          setError('Enter a valid Trello API key and token.');
          return;
        }
        setBusy(true);
        setError(null);
        void submit(validated.data)
          .catch(() => {
            // The host renders submission failures outside the plugin form.
          })
          .finally(() => setBusy(false));
      }}
    />
  );
}

function TrelloSettingsInfo() {
  const navigate = useBbNavigate();
  const { projectId } = useBbContext();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Connect the Trello API key and token once, then map each bb project to a Trello
        board, correct its list states, and set the default board layout.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          navigate.toPluginPanel(PANEL_PATH, {
            subPath: projectId ? routeToSubPath({ kind: 'manage', projectId }) : 'manage'
          })
        }
      >
        <Icon name="Settings" className="size-4" />
        Open Trello project settings
      </Button>
    </div>
  );
}

export default definePluginApp(app => {
  app.composer.customize({
    id: 'create-trello-card',
    scopes: ['thread', 'new-thread'],
    actions: [{ id: 'create-task', component: ComposerCreateTaskAction }]
  });
  app.slots.threadPanelAction({
    id: THREAD_PANEL_ACTION_ID,
    title: 'Trello',
    icon: 'Ticket',
    component: TrelloThreadPanel,
    layout: 'flush'
  });
  app.slots.experimental_newThreadPanelAction({
    id: 'trello-new-thread-panel',
    title: 'Trello',
    icon: 'Ticket',
    component: TrelloNewThreadPanel,
    layout: 'flush'
  });
  app.slots.experimental_threadHeaderAction({
    id: 'open-trello-panel',
    title: 'Trello',
    component: TrelloThreadHeaderAction
  });
  app.slots.navPanel({
    id: 'trello',
    title: 'Trello',
    icon: 'Ticket',
    path: PANEL_PATH,
    component: TrelloPanel,
    headerContent: TrelloHeaderAction
  });
  app.slots.settingsSection({
    id: 'connections',
    title: 'Trello',
    description: 'Connect Trello and map each project to a board.',
    component: TrelloSettingsInfo
  });
  app.slots.pendingInteraction({
    id: 'trello-connection',
    component: TrelloConnectionInteraction
  });
  // There is no project-page slot in the SDK — the command palette is the
  // intended way to jump to the board from anywhere.
  app.slots.commandPaletteAction({
    id: 'open-board',
    title: 'Trello: Open board',
    run: context => {
      const navigate = useBbNavigate();
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: context.projectId
          ? routeToSubPath({ kind: 'project', projectId: context.projectId })
          : ''
      });
    }
  });
});
