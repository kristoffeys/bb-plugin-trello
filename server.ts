// bb-plugin-trello — backend entry.
//
// One Trello credential pair (an API key plus a user token) serves every bb
// project. A bb project is mapped to exactly one Trello board; the board for
// that bb project is the mapped board's cards, optionally narrowed to the
// connected member.
//
// Surfaces, all reading the same cache:
//   - the Trello nav panel and thread panel (app.tsx, over RPC)
//   - the `bb trello` CLI command
//   - the `trello-card` mention provider (@ / # in the composer)
//   - skills/trello/SKILL.md, which tells agents to use the CLI
//
// Both credentials live in 0600 files rather than plugin settings so changing
// them does not require a plugin reload — and because Trello sends them as
// query parameters, keeping them out of argv and logs matters more than usual.
import { join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import {
  CONNECTION_CHANGED,
  ITEMS_CHANGED,
  PRESETS_CHANGED,
  connectionInteractionResponseSchema,
  boardViewStateSchema,
  filterPresetSummary,
  formatWorkItemContext,
  mentionId,
  parseMentionId,
  trelloRpcContract,
  type BoardStatus,
  type ConnectionView,
  type CreateTaskInput,
  type ListCategories,
  type ProjectScope,
  type ProjectScopeView,
  type WorkItem,
  type WorkItemDetail,
  threadTitleForItem,
  formatWorkItemHandoffPrompt,
  type WorkAttachment,
  type WorkStateCategory,
  type WorkStatusOption
} from './contract.js';
import { createWorkItemStore, type ProjectScopeDefaults } from './store.js';
import { deleteSecretFile, writeSecretFile } from './lib/secret-file.js';
import { flagValue, positionalArgs } from './cli-args.js';
import {
  TrelloApiError,
  BOARD_CARD_LIMIT,
  cardStateCategory,
  createTrelloApi,
  isAuthError,
  type TrelloApi,
  type TrelloAttachment,
  type TrelloCard,
  type TrelloMember
} from './trello/index.js';

const SYNC_INTERVAL_MS = 5 * 60_000;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info('loaded');

  const store = createWorkItemStore(bb);
  const pluginDataDirectory = dirname(bb.storage.database().name);
  const keyPath = join(pluginDataDirectory, 'secrets', 'api-key');
  const tokenPath = join(pluginDataDirectory, 'secrets', 'api-token');

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async function readSecret(path: string): Promise<string | null> {
    try {
      const value = (await readFile(path, 'utf8')).trim();
      return value === '' ? null : value;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }
      throw error;
    }
  }

  async function readCredentials(): Promise<{
    apiKey: string | null;
    apiToken: string | null;
  }> {
    const [apiKey, apiToken] = await Promise.all([
      readSecret(keyPath),
      readSecret(tokenPath)
    ]);
    return { apiKey, apiToken };
  }

  // One API client per credential pair. Rebuilt whenever the connection
  // changes so a re-keyed connection never keeps serving reads with the old
  // credential. The cache key is never logged — it contains both secrets.
  let apiCache: { key: string; api: TrelloApi } | null = null;
  /** Resolved viewer; cleared whenever the connection changes. */
  let viewerCache: { key: string; member: TrelloMember | null } | null = null;

  async function currentApi(): Promise<TrelloApi | null> {
    const { apiKey, apiToken } = await readCredentials();
    if (apiKey === null || apiToken === null) return null;
    const key = `${apiKey}:${apiToken}`;
    if (apiCache?.key !== key) {
      apiCache = { key, api: createTrelloApi({ apiKey, apiToken }) };
    }
    return apiCache.api;
  }

  /** Never let an upstream error text reach a caller verbatim. */
  function safeMessage(error: unknown): string {
    if (error instanceof TrelloApiError) {
      if (isAuthError(error)) {
        return 'Trello rejected the API key or token. Update the connection.';
      }
      return `Trello request failed${
        error.status === null ? '' : ` (HTTP ${error.status})`
      }.`;
    }
    return 'Could not reach Trello.';
  }

  /**
   * The member the token belongs to. Cached because it is read on every board
   * open and on every "assigned to me" sync, and Trello's /members/ endpoints
   * carry their own tighter rate limit (100 per 15 minutes).
   */
  async function viewerMember(): Promise<TrelloMember | null> {
    const { apiKey, apiToken } = await readCredentials();
    if (apiKey === null || apiToken === null) return null;
    const cacheKey = `${apiKey}:${apiToken}`;
    if (viewerCache?.key === cacheKey) return viewerCache.member;
    const api = await currentApi();
    if (api === null) return null;
    const member = await api.getViewer();
    viewerCache = { key: cacheKey, member };
    return member;
  }

  async function connectionView(): Promise<ConnectionView> {
    const { apiKey, apiToken } = await readCredentials();
    const configured = apiKey !== null && apiToken !== null;
    if (!configured) {
      return {
        configured: false,
        viewerName: null,
        memberId: '',
        available: false,
        message:
          apiKey === null && apiToken === null
            ? 'Add a Trello API key and token to connect.'
            : apiKey === null
              ? 'Add a Trello API key to connect.'
              : 'Add a Trello API token to connect.'
      };
    }
    try {
      const member = await viewerMember();
      if (member === null) {
        return {
          configured,
          viewerName: null,
          memberId: '',
          available: false,
          message: 'Trello did not return a member for this token.'
        };
      }
      return {
        configured,
        viewerName: member.name,
        memberId: member.id,
        available: true,
        message: null
      };
    } catch (error) {
      return {
        configured,
        viewerName: null,
        memberId: '',
        available: false,
        message: safeMessage(error)
      };
    }
  }

  async function requireApi(): Promise<TrelloApi> {
    const api = await currentApi();
    if (api === null) {
      throw new Error(
        'Trello is not connected. Set the API key and token first.'
      );
    }
    return api;
  }

  /** Drops both cached credentials-derived objects after a connection change. */
  function invalidateConnection(): void {
    apiCache = null;
    viewerCache = null;
  }

  // -------------------------------------------------------------------------
  // Mapping cards onto the board model
  // -------------------------------------------------------------------------

  function toWorkItem(
    card: TrelloCard,
    bbProjectId: string,
    listCategories: ListCategories
  ): WorkItem {
    return {
      bbProjectId,
      locator: card.id,
      key: card.key,
      title: card.title,
      description: card.description,
      url: card.url,
      status: card.status.name,
      statusId: card.status.id,
      // Why re-derived here and not taken from the card: the per-list override
      // is board settings, which the API layer knows nothing about.
      stateCategory: cardStateCategory(card, listCategories),
      assignee: card.assignee?.name ?? null,
      assigneeId: card.assignee?.id ?? card.assigneeId ?? null,
      board: card.board.name || null,
      boardId: card.boardId || null,
      labels: card.labels ?? [],
      dueDate: card.dueDate ?? null,
      updatedAt: card.updatedAt
    };
  }

  async function toWorkItemDetail(
    card: TrelloCard,
    bbProjectId: string,
    api: TrelloApi,
    listCategories: ListCategories
  ): Promise<WorkItemDetail> {
    const [comments, attachments] = await Promise.all([
      api.getCardComments(card.id),
      api.listCardAttachments(card.id)
    ]);
    return {
      ...toWorkItem(card, bbProjectId, listCategories),
      comments: comments.map(comment => ({
        author: comment.user?.name ?? 'Unknown',
        body: comment.body,
        createdAt: comment.createdAt,
        attachments: (comment.attachments ?? []).map(toWorkAttachment)
      })),
      attachments: attachments.map(toWorkAttachment)
    };
  }

  function toWorkAttachment(attachment: TrelloAttachment): WorkAttachment {
    return {
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      url: attachment.url,
      thumbUrl: attachment.thumbUrl ?? null,
      isImage: attachment.isImage,
      createdAt: attachment.createdAt
    };
  }

  // -------------------------------------------------------------------------
  // Scope + sync
  // -------------------------------------------------------------------------

  const SCOPE_DEFAULTS: ProjectScopeDefaults = {
    boardId: '',
    assignedToMeOnly: false,
    includeClosed: false,
    listCategories: {}
  };

  async function scopeView(projectId: string): Promise<ProjectScopeView> {
    const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
    const { apiKey, apiToken } = await readCredentials();
    // Cached items carry the board name, so the common case needs no call.
    const [sample] = store.list({ projectId, limit: 1 });
    return {
      ...scope,
      boardName: scope.boardId === '' ? null : (sample?.board ?? null),
      connectionConfigured: apiKey !== null && apiToken !== null
    };
  }

  // Guards against a slow sync writing results for a scope the user has since
  // changed. Bumped on every scope or connection change.
  const revisions = new Map<string, number>();
  function revision(projectId: string): number {
    return revisions.get(projectId) ?? 0;
  }
  function advanceRevision(projectId: string): number {
    const next = revision(projectId) + 1;
    revisions.set(projectId, next);
    return next;
  }

  async function syncProject(projectId: string): Promise<BoardStatus> {
    const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
    if (scope.boardId === '') {
      return store.syncStatus(projectId);
    }
    const startedAt = revision(projectId);
    try {
      const api = await requireApi();
      const viewer = scope.assignedToMeOnly ? await viewerMember() : null;
      const { cards, matchedCount } = await api.listCards({
        boardId: scope.boardId,
        memberId: viewer?.id,
        status: scope.includeClosed ? 'all' : 'open',
        // Without an explicit limit this stops at the per-call default and the
        // board shows a truncated project.
        limit: BOARD_CARD_LIMIT
      });
      if (revision(projectId) !== startedAt) return store.syncStatus(projectId);
      const items = cards.map(card =>
        toWorkItem(card, projectId, scope.listCategories)
      );
      const notice =
        matchedCount > cards.length
          ? `This board has ${matchedCount} cards in scope; showing the ` +
            `${cards.length} most recently updated.`
          : null;
      store.replaceAll(projectId, items, new Date().toISOString(), notice);
    } catch (error) {
      bb.log.warn(`sync failed for ${projectId}: ${safeMessage(error)}`);
      store.setSyncError(projectId, safeMessage(error));
    }
    const status = store.syncStatus(projectId);
    bb.realtime.publish(ITEMS_CHANGED, { projectId });
    return status;
  }

  /**
   * Read a single card straight from Trello and refresh its cache row.
   *
   * Publishes ITEMS_CHANGED only when the cached row actually changed. The
   * guard lives here, where every caller routes through, because the naive
   * "publish on every refresh" version created a feedback loop: opening a card
   * called getItem -> refreshItem -> publish, the detail view's ITEMS_CHANGED
   * subscriber refetched, and the board hammered Trello until it 429ed. A read
   * that finds nothing new is not a change.
   */
  async function refreshItem(
    projectId: string,
    locator: string
  ): Promise<WorkItemDetail> {
    const api = await requireApi();
    const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
    const card = await api.getCard(locator);
    if (card === null) throw new Error(`No Trello card ${locator}`);
    const detail = await toWorkItemDetail(
      card,
      projectId,
      api,
      scope.listCategories
    );
    const { comments: _comments, attachments: _attachments, ...item } = detail;
    const previous = store.get(projectId, locator);
    store.upsert(projectId, item);
    if (previous === null || !sameWorkItem(previous, item)) {
      bb.realtime.publish(ITEMS_CHANGED, { projectId });
    }
    return detail;
  }

  /** A ticket-per-worktree keeps parallel tickets from colliding in one checkout. */
  function threadEnvironment(
    kind: 'project-default' | 'worktree'
  ): Parameters<typeof bb.sdk.threads.spawn>[0]['environment'] {
    return kind === 'worktree'
      ? {
          type: 'host',
          workspace: {
            type: 'managed-worktree',
            baseBranch: { kind: 'default' }
          }
        }
      : { type: 'project-default' };
  }

  /** Field-wise equality; the cache row is flat, so a shallow compare is enough. */
  function sameWorkItem(left: WorkItem, right: WorkItem): boolean {
    const keys = Object.keys(right) as (keyof WorkItem)[];
    return keys.every(key => {
      const leftValue = left[key];
      const rightValue = right[key];
      if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
        return (
          leftValue.length === rightValue.length &&
          leftValue.every((entry, index) => entry === rightValue[index])
        );
      }
      return leftValue === rightValue;
    });
  }

  /** The board's lists, with the per-list category override applied. */
  async function boardListsFor(
    projectId: string,
    explicitBoardId?: string
  ): Promise<
    {
      id: string;
      name: string;
      guessedCategory: WorkStateCategory;
      stateCategory: WorkStateCategory;
    }[]
  > {
    const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
    const boardId = explicitBoardId || scope.boardId;
    if (boardId === '') return [];
    const api = await requireApi();
    const lists = await api.listLists(boardId);
    return lists.map(list => ({
      id: list.id,
      name: list.name,
      guessedCategory: list.stateCategory,
      stateCategory: scope.listCategories[list.id] ?? list.stateCategory
    }));
  }

  async function statusOptionsFor(
    projectId: string,
    locator: string
  ): Promise<WorkStatusOption[]> {
    const cached = store.get(projectId, locator);
    const lists = await boardListsFor(projectId);
    // Why every list is offered: Trello has no transition model, so any list on
    // the board is a legal destination for any card on it.
    return lists.map(list => ({
      id: list.id,
      name: list.name,
      stateCategory: list.stateCategory,
      current: cached?.statusId === list.id
    }));
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  bb.rpc.register(trelloRpcContract, {
    listProjects: async () => {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: projects.map(project => ({
          id: project.id,
          name: project.name
        }))
      };
    },
    threadProject: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      return { projectId: thread.projectId };
    },
    getConnection: async () => ({ connection: await connectionView() }),
    saveConnection: async input => {
      await applyCredentialMutation(input.apiKey, keyPath);
      await applyCredentialMutation(input.apiToken, tokenPath);
      invalidateConnection();
      for (const projectId of store.configuredProjectIds()) {
        advanceRevision(projectId);
      }
      const connection = await connectionView();
      bb.realtime.publish(CONNECTION_CHANGED, {
        configured: connection.configured
      });
      return { connection };
    },
    status: async ({ projectId }) => ({ status: store.syncStatus(projectId) }),
    listItems: async ({ projectId, query, stateCategories, limit }) => ({
      items: store.list({ projectId, query, stateCategories, limit })
    }),
    refresh: async ({ projectId }) => {
      const status = await syncProject(projectId);
      return { status, itemCount: status.itemCount };
    },
    getItem: async ({ projectId, locator }) => ({
      item: await refreshItem(projectId, locator)
    }),
    statusOptions: async ({ projectId, locator }) => ({
      options: await statusOptionsFor(projectId, locator)
    }),
    updateItemStatus: async ({ projectId, locator, statusId }) => {
      const api = await requireApi();
      await api.updateCard(locator, { listId: statusId });
      const detail = await refreshItem(projectId, locator);
      const { comments: _comments, attachments: _attachments, ...item } = detail;
      return { item };
    },
    updateItemAssignee: async ({ projectId, locator, assigneeId }) => {
      const api = await requireApi();
      await api.updateCard(locator, { assigneeId });
      const detail = await refreshItem(projectId, locator);
      const { comments: _comments, attachments: _attachments, ...item } = detail;
      return { item };
    },
    updateItemContent: async ({ projectId, locator, title, description }) => {
      const api = await requireApi();
      await api.updateCard(locator, { title, description });
      return { item: await refreshItem(projectId, locator) };
    },
    addComment: async ({ projectId, locator, body }) => {
      const api = await requireApi();
      await api.addCardComment(locator, body);
      return { item: await refreshItem(projectId, locator) };
    },
    getCreateTaskContext: async ({ projectId }) => {
      const project = (await bb.sdk.projects.list({ includePersonal: true }))
        .find(candidate => candidate.id === projectId);
      const scope = await scopeView(projectId);
      const connection = await connectionView();
      return {
        context: {
          projectId,
          projectName: project?.name ?? projectId,
          available: connection.available && scope.boardId !== '',
          message: !connection.configured
            ? 'Trello is not connected.'
            : scope.boardId === ''
              ? 'This bb project is not mapped to a Trello board yet.'
              : connection.message,
          boardId: scope.boardId === '' ? null : scope.boardId,
          boardName: scope.boardName
        }
      };
    },
    getCreateTaskMetadata: async ({ projectId }) => {
      const scope = store.projectScope(projectId, SCOPE_DEFAULTS);
      if (scope.boardId === '') {
        return {
          ok: false as const,
          error: {
            code: 'metadata_unavailable' as const,
            safeMessage: 'This bb project is not mapped to a Trello board yet.'
          }
        };
      }
      try {
        const api = await requireApi();
        const [lists, members] = await Promise.all([
          boardListsFor(projectId),
          api.listBoardMembers(scope.boardId)
        ]);
        return {
          ok: true as const,
          metadata: {
            statusOptions: lists.map(list => ({ id: list.id, label: list.name })),
            assigneeOptions: members.map(member => ({
              id: member.id,
              label: member.name
            })),
            // The leftmost list is where Trello itself drops a new card.
            defaultStatusId: lists[0]?.id ?? null
          },
          connectorRevision: revision(projectId)
        };
      } catch (error) {
        return {
          ok: false as const,
          error: {
            code: 'metadata_unavailable' as const,
            safeMessage: safeMessage(error)
          }
        };
      }
    },
    createTask: async input => createTask(input),
    startThread: async ({ projectId, locator, environment }) => {
      // The card is re-read rather than taken from cache so the agent starts
      // from what Trello says right now, not a stale board row.
      const detail = await refreshItem(projectId, locator);
      const { comments: _comments, attachments: _attachments, ...item } = detail;
      const title = threadTitleForItem(item);
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: threadEnvironment(environment),
        title,
        prompt: formatWorkItemHandoffPrompt(detail)
      });
      return { threadId: thread.id, title };
    },
    getProjectScope: async ({ projectId }) => ({
      scope: await scopeView(projectId)
    }),
    saveProjectScope: async scope => {
      store.saveProjectScope(scope);
      advanceRevision(scope.projectId);
      void syncProject(scope.projectId);
      return { scope: await scopeView(scope.projectId) };
    },
    listTrelloBoards: async ({ query }) => {
      const api = await requireApi();
      const boards = await api.listBoards({ query, limit: 200 });
      return {
        boards: boards.map(board => ({
          id: board.id,
          name: board.name,
          url: board.url ?? null
        }))
      };
    },
    listBoardLists: async ({ projectId, boardId }) => ({
      lists: await boardListsFor(projectId, boardId)
    }),
    getBoardView: async ({ projectId }) => {
      const stored = store.readBoardView(projectId);
      if (stored === null) return { view: null };
      // A stale row from an older schema must not stop the board opening.
      const parsed = boardViewStateSchema.safeParse(stored);
      return { view: parsed.success ? parsed.data : null };
    },
    saveBoardView: async ({ projectId, view }) => {
      store.writeBoardView(projectId, view);
      return { saved: true as const };
    },
    getProjectBoardSettings: async ({ projectId }) => ({
      settings: store.boardSettings(projectId)
    }),
    saveProjectBoardSettings: async settings => {
      store.saveBoardSettings(settings);
      return { settings };
    },
    listFilterPresets: async ({ projectId }) => ({
      presets: store.listPresets(projectId)
    }),
    saveFilterPreset: async ({ projectId, id, name, state }) => {
      const saved = store.savePreset({ projectId, id, name, state });
      const preset = filterPresetSummary(saved);
      const presets = store.listPresets(projectId);
      bb.realtime.publish(PRESETS_CHANGED, { projectId });
      return { preset, presets };
    },
    deleteFilterPreset: async ({ projectId, id }) => {
      const presets = store.deletePreset(projectId, id);
      bb.realtime.publish(PRESETS_CHANGED, { projectId });
      return { presets };
    },
    reorderFilterPresets: async ({ projectId, ids }) => {
      const presets = store.reorderPresets(projectId, ids);
      bb.realtime.publish(PRESETS_CHANGED, { projectId });
      return { presets };
    }
  });

  async function applyCredentialMutation(
    mutation: { operation: 'keep' } | { operation: 'clear' } | { operation: 'set'; value: string },
    path: string
  ): Promise<void> {
    if (mutation.operation === 'set') {
      await writeSecretFile(path, mutation.value);
    } else if (mutation.operation === 'clear') {
      await deleteSecretFile(path);
    }
  }

  async function createTask(input: CreateTaskInput) {
    const scope = store.projectScope(input.projectId, SCOPE_DEFAULTS);
    if (scope.boardId === '') {
      throw new Error('This bb project is not mapped to a Trello board.');
    }
    if (input.connectorRevision !== revision(input.projectId)) {
      throw new Error(
        'The Trello connection changed while this form was open. Reopen it and try again.'
      );
    }
    const api = await requireApi();
    const created = await api.createCard({
      listId: input.statusId,
      title: input.title,
      description: input.description,
      assigneeId: input.assigneeId ?? undefined,
      dueDate: input.dueDate ?? undefined
    });
    const item = toWorkItem(created, input.projectId, scope.listCategories);
    store.upsert(input.projectId, item);
    bb.realtime.publish(ITEMS_CHANGED, { projectId: input.projectId });

    // Trello silently ignores a member the token may not add, so the result is
    // reported rather than assumed.
    const warnings: string[] = [];
    const requestedAssignee = input.assigneeId;
    const assigneeConfirmation =
      requestedAssignee === null
        ? ({ confirmed: true, id: null } as const)
        : item.assigneeId === requestedAssignee
          ? ({ confirmed: true, id: item.assigneeId } as const)
          : ({ confirmed: false } as const);
    if (assigneeConfirmation.confirmed === false) {
      warnings.push('Trello did not apply the requested assignee.');
    }
    if (item.statusId !== input.statusId) {
      warnings.push('Trello did not put the card in the requested list.');
    }

    return {
      item,
      warnings,
      assigneeConfirmation,
      mention: {
        provider: 'trello-card' as const,
        id: mentionId(item),
        label: item.key
      }
    };
  }

  // -------------------------------------------------------------------------
  // Composer mentions
  // -------------------------------------------------------------------------

  bb.ui.registerMentionProvider({
    id: 'trello-card',
    label: 'Trello',
    triggers: ['@', '#'],
    async search({ query, projectId }) {
      if (typeof projectId !== 'string') return [];
      const trimmed = query.trim();
      return store
        .list({ projectId, query: trimmed, limit: 10 })
        .map(item => ({
          id: mentionId(item),
          title: `${item.key} ${item.title}`,
          subtitle: `Trello · ${item.status}${
            item.assignee === null ? '' : ` · ${item.assignee}`
          }`
        }));
    },
    async resolve(id) {
      const parsed = parseMentionId(id);
      const item =
        parsed === null ? null : store.get(parsed.projectId, parsed.locator);
      if (item === null) {
        // The mention outlived its cache row (card deleted, or the project was
        // remapped). Say so rather than silently dropping the reference.
        return {
          context: `Trello card ${id} is no longer in this project's board cache.`
        };
      }
      return { context: formatWorkItemContext(item) };
    }
  });

  // -------------------------------------------------------------------------
  // Connection interaction (the form app.tsx renders for `trello-connection`)
  // -------------------------------------------------------------------------

  async function requestConnectionInput(
    threadId: string,
    signal: AbortSignal | undefined
  ): Promise<ConnectionView | null> {
    const { apiKey, apiToken } = await readCredentials();
    const result = await bb.ui.requestInput(
      {
        threadId,
        rendererId: 'trello-connection',
        title: 'Connect Trello',
        payload: {
          keyConfigured: apiKey !== null,
          tokenConfigured: apiToken !== null
        }
      },
      { signal }
    );
    if (result.outcome !== 'submitted') return null;
    const response = connectionInteractionResponseSchema.parse(result.value);
    await applyCredentialMutation(response.apiKey, keyPath);
    await applyCredentialMutation(response.apiToken, tokenPath);
    invalidateConnection();
    const connection = await connectionView();
    bb.realtime.publish(CONNECTION_CHANGED, {
      configured: connection.configured
    });
    return connection;
  }

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  const usage = [
    'Usage:',
    '  bb trello status [--project <proj_id>] [--json]',
    '  bb trello list [--project <proj_id>] [--query <text>] [--state <todo|in_progress|done>] [--cached] [--json]',
    '  bb trello show <locator> [--project <proj_id>] [--json]',
    '  bb trello start <locator> [--worktree] [--project <proj_id>] [--json]',
    '  bb trello lists [--project <proj_id>] [--json]',
    '  bb trello move <locator> --status <list-id> [--project <proj_id>] [--json]',
    '  bb trello comment <locator> <text> [--project <proj_id>] [--json]',
    '  bb trello edit <locator> [--title <text>] [--description <text>] [--project <proj_id>] [--json]',
    '  bb trello create --title <text> --list <list-id> [--description <text>]',
    '                   [--assignee <member-id>] [--due <YYYY-MM-DD>]',
    '                   [--project <proj_id>] [--json]',
    '  bb trello refresh [--project <proj_id>] [--json]',
    '  bb trello config [--project <proj_id>] [--board <id>]',
    '                   [--assigned-to-me <on|off>] [--include-closed <on|off>] [--json]',
    '  bb trello connect [--json]',
    '  bb trello connect --key-file <path> --token-file <path>',
    '  bb trello disconnect [--json]',
    '  bb trello presets list [--project <proj_id>] [--json]'
  ].join('\n');

  function formatItem(item: WorkItem): string {
    return [
      item.key.padEnd(8),
      item.status.padEnd(14),
      (item.assignee ?? '—').padEnd(16),
      item.title
    ].join('  ');
  }

  bb.cli.register({
    name: 'trello',
    summary: "Browse and update the current project's Trello cards",
    commands: [
      {
        name: 'status',
        summary: 'Show the board mapping, last sync, and card count',
        usage: 'bb trello status [--project <proj_id>] [--json]'
      },
      {
        name: 'list',
        summary: "List the project's Trello cards",
        usage:
          'bb trello list [--project <proj_id>] [--query <text>] [--state <todo|in_progress|done>] [--cached] [--json]'
      },
      {
        name: 'show',
        summary: 'Show one card with its description and comments',
        usage: 'bb trello show <locator> [--project <proj_id>] [--json]'
      },
      {
        name: 'start',
        summary: 'Start a bb thread to work on a card',
        usage:
          'bb trello start <locator> [--worktree] [--project <proj_id>] [--json]'
      },
      {
        name: 'lists',
        summary: "List the board's lists — the ids `move` and `create` take",
        usage: 'bb trello lists [--project <proj_id>] [--json]'
      },
      {
        name: 'move',
        summary: 'Move a card to another list',
        usage: 'bb trello move <locator> --status <list-id> [--json]'
      },
      {
        name: 'comment',
        summary: 'Add a comment to a card',
        usage: 'bb trello comment <locator> <text> [--json]'
      },
      {
        name: 'edit',
        summary: "Edit a card's title or description",
        usage:
          'bb trello edit <locator> [--title <text>] [--description <text>] [--json]'
      },
      {
        name: 'create',
        summary: 'Create a card in a list on the mapped board',
        usage:
          'bb trello create --title <text> --list <list-id> [--description <text>] [--json]'
      },
      {
        name: 'refresh',
        summary: 'Force a sync with Trello',
        usage: 'bb trello refresh [--project <proj_id>] [--json]'
      },
      {
        name: 'config',
        summary: "Show or change this bb project's Trello board mapping",
        usage: 'bb trello config [--board <id>] [--json]'
      },
      {
        name: 'connect',
        summary:
          'Show the Trello connection, or set it with --key-file and --token-file',
        usage:
          'bb trello connect [--key-file <path> --token-file <path>] [--json]'
      },
      {
        name: 'disconnect',
        summary: 'Remove the stored Trello API key and token',
        usage: 'bb trello disconnect [--json]'
      },
      {
        name: 'presets',
        summary: "List the board's saved filter presets",
        usage: 'bb trello presets list [--project <proj_id>] [--json]'
      }
    ],
    async run(argv, context) {
      const json = argv.includes('--json');
      const cached = argv.includes('--cached');
      const args = argv.filter(arg => arg !== '--json' && arg !== '--cached');
      const [command, ...rest] = positionalArgs(argv);

      const projectId =
        flagValue(args, '--project') ?? context?.projectId ?? null;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const needProject = () =>
        fail(
          'No bb project in context. Pass --project <proj_id>. Run "bb project list" to see ids.'
        );

      try {
        switch (command) {
          case undefined:
          case 'help':
          case '--help':
            return { exitCode: 0, stdout: usage };

          case 'disconnect': {
            await deleteSecretFile(keyPath);
            await deleteSecretFile(tokenPath);
            invalidateConnection();
            const connection = await connectionView();
            bb.realtime.publish(CONNECTION_CHANGED, { configured: false });
            return reply(
              connection,
              'Disconnected. The stored API key and token were removed.'
            );
          }

          case 'connect': {
            // Why files and not flag values: a plugin CLI command runs inside
            // the BB server, so it has no stdin to pipe a secret through. Paths
            // keep both credentials out of argv, shell history, and agent
            // transcripts — which matters doubly here, since Trello sends them
            // as query parameters.
            const keyFile = flagValue(args, '--key-file');
            const tokenFile = flagValue(args, '--token-file');
            if (keyFile !== null || tokenFile !== null) {
              if (keyFile === null || tokenFile === null) {
                return fail(
                  'Pass both --key-file <path> and --token-file <path>.'
                );
              }
              const credentials: Record<string, string> = {};
              for (const [label, file] of [
                ['API key', keyFile],
                ['API token', tokenFile]
              ] as const) {
                let value: string;
                try {
                  value = (await readFile(file, 'utf8')).trim();
                } catch {
                  return fail(`Could not read the ${label} from ${file}.`);
                }
                if (value === '') return fail(`${file} is empty.`);
                if (/[\r\n]/u.test(value)) {
                  return fail(`The ${label} must be a single line.`);
                }
                credentials[label] = value;
              }
              await writeSecretFile(keyPath, credentials['API key']!);
              await writeSecretFile(tokenPath, credentials['API token']!);
              invalidateConnection();
              const saved = await connectionView();
              bb.realtime.publish(CONNECTION_CHANGED, {
                configured: saved.configured
              });
              return reply(
                saved,
                saved.available
                  ? `Connected to Trello as ${saved.viewerName ?? saved.memberId}`
                  : `Saved, but Trello is not reachable: ${saved.message ?? 'unknown error'}`
              );
            }
            const connection = await connectionView();
            return reply(
              connection,
              connection.configured
                ? `Connected to Trello${
                    connection.viewerName === null
                      ? ''
                      : ` as ${connection.viewerName}`
                  }${
                    connection.available
                      ? ''
                      : ` — ${connection.message ?? 'unavailable'}`
                  }`
                : 'Not connected. Open the Trello panel in BB, or run:\n'
                  + '  bb trello connect --key-file <path> --token-file <path>'
            );
          }

          case 'status': {
            if (projectId === null) return needProject();
            const [scope, status] = await Promise.all([
              scopeView(projectId),
              Promise.resolve(store.syncStatus(projectId))
            ]);
            return reply({ scope, status }, [
              `bb project:          ${projectId}`,
              `Trello board:        ${
                scope.boardId === ''
                  ? 'not mapped'
                  : `${scope.boardName ?? 'unknown'} (${scope.boardId})`
              }`,
              `Assigned to me only: ${scope.assignedToMeOnly ? 'yes' : 'no'}`,
              `Include archived:    ${scope.includeClosed ? 'yes' : 'no'}`,
              `List overrides:      ${Object.keys(scope.listCategories).length}`,
              `Last synced:         ${status.lastSyncedAt ?? 'never'}`,
              `Cards cached:        ${status.itemCount}`,
              ...(status.message === null
                ? []
                : [
                    `${(status.available ? 'Note:' : 'Error:').padEnd(21)}${
                      status.message
                    }`
                  ])
            ].join('\n'));
          }

          case 'list': {
            if (projectId === null) return needProject();
            if (!cached) await syncProject(projectId);
            const state = flagValue(args, '--state');
            const stateCategories =
              state === null ? undefined : [state as WorkStateCategory];
            const items = store.list({
              projectId,
              query: flagValue(args, '--query') ?? undefined,
              stateCategories,
              limit: 200
            });
            return reply(
              items,
              items.length === 0
                ? 'No cards.'
                : items.map(formatItem).join('\n')
            );
          }

          case 'show': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            if (locator === undefined) return fail(usage);
            const item = await refreshItem(projectId, locator);
            return reply(item, formatWorkItemContext(item));
          }

          case 'start': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            if (locator === undefined) return fail(usage);
            const detail = await refreshItem(projectId, locator);
            const { comments: _c, attachments: _a, ...item } = detail;
            const title = threadTitleForItem(item);
            const worktree = argv.includes('--worktree');
            const thread = await bb.sdk.threads.spawn({
              projectId,
              environment: threadEnvironment(
                worktree ? 'worktree' : 'project-default'
              ),
              title,
              prompt: formatWorkItemHandoffPrompt(detail)
            });
            return reply(
              { threadId: thread.id, title, locator, url: item.url, worktree },
              `Started thread ${thread.id}${worktree ? ' in a new worktree' : ''} — ${title}`
            );
          }

          case 'lists': {
            if (projectId === null) return needProject();
            const lists = await boardListsFor(projectId);
            return reply(
              lists,
              lists.length === 0
                ? 'No lists. Map this bb project to a Trello board first.'
                : lists
                    .map(
                      list =>
                        `${list.id.padEnd(26)} ${list.name} (${list.stateCategory}${
                          list.stateCategory === list.guessedCategory ? '' : ', overridden'
                        })`
                    )
                    .join('\n')
            );
          }

          case 'move': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            const statusId = flagValue(args, '--status');
            if (locator === undefined || statusId === null) return fail(usage);
            const api = await requireApi();
            await api.updateCard(locator, { listId: statusId });
            const item = await refreshItem(projectId, locator);
            return reply(item, `Moved ${item.key} to ${item.status}`);
          }

          case 'comment': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            const body = rest.slice(1).join(' ').trim();
            if (locator === undefined || body === '') return fail(usage);
            const api = await requireApi();
            await api.addCardComment(locator, body);
            const item = await refreshItem(projectId, locator);
            return reply(
              { locator, added: true },
              `Commented on ${item.key}`
            );
          }

          case 'edit': {
            if (projectId === null) return needProject();
            const locator = rest[0];
            const title = flagValue(args, '--title');
            const description = flagValue(args, '--description');
            if (locator === undefined) return fail(usage);
            if (title === null && description === null) {
              return fail(
                'Pass --title and/or --description with the new value.'
              );
            }
            const api = await requireApi();
            await api.updateCard(locator, {
              ...(title === null ? {} : { title }),
              ...(description === null ? {} : { description })
            });
            const item = await refreshItem(projectId, locator);
            return reply(
              item,
              `Updated ${item.key}: ${item.title}`
            );
          }

          case 'create': {
            if (projectId === null) return needProject();
            const title = flagValue(args, '--title');
            const listId = flagValue(args, '--list');
            if (title === null) return fail(usage);
            if (listId === null) {
              return fail(
                'Pass --list <list-id>. A Trello card must be created in a list; run "bb trello lists" for the ids.'
              );
            }
            const result = await createTask({
              projectId,
              connectorRevision: revision(projectId),
              title,
              description: flagValue(args, '--description') ?? '',
              statusId: listId,
              assigneeId: flagValue(args, '--assignee'),
              dueDate: flagValue(args, '--due')
            });
            return reply(
              result,
              [
                `Created ${result.item.key}: ${result.item.title}`,
                result.item.url,
                ...result.warnings
              ].join('\n')
            );
          }

          case 'refresh': {
            if (projectId === null) return needProject();
            const status = await syncProject(projectId);
            return reply(
              status,
              status.available
                ? `Synced ${status.itemCount} cards.${
                    status.message === null ? '' : ` ${status.message}`
                  }`
                : `Sync failed: ${status.message}`
            );
          }

          case 'config': {
            if (projectId === null) return needProject();
            const current = store.projectScope(projectId, SCOPE_DEFAULTS);
            const onOff = (flag: string, fallback: boolean): boolean => {
              const value = flagValue(args, flag);
              if (value === null) return fallback;
              return value === 'on' || value === 'true' || value === 'yes';
            };
            const next: ProjectScope = {
              projectId,
              boardId: flagValue(args, '--board') ?? current.boardId,
              assignedToMeOnly: onOff(
                '--assigned-to-me',
                current.assignedToMeOnly
              ),
              includeClosed: onOff('--include-closed', current.includeClosed),
              // Overrides are per list id, so a board change invalidates them.
              listCategories:
                (flagValue(args, '--board') ?? current.boardId) === current.boardId
                  ? current.listCategories
                  : {}
            };
            const changed = JSON.stringify(next) !== JSON.stringify(current);
            if (changed) {
              store.saveProjectScope(next);
              advanceRevision(projectId);
              await syncProject(projectId);
            }
            const view = await scopeView(projectId);
            return reply(
              view,
              [
                `Trello board:        ${view.boardId || 'not mapped'}`,
                `Assigned to me only: ${view.assignedToMeOnly ? 'yes' : 'no'}`,
                `Include archived:    ${view.includeClosed ? 'yes' : 'no'}`
              ].join('\n')
            );
          }

          case 'presets': {
            if (projectId === null) return needProject();
            if (rest[0] !== 'list') return fail(usage);
            const presets = store.listPresets(projectId);
            return reply(
              presets,
              presets.length === 0
                ? 'No filter presets.'
                : presets.map(preset => `${preset.id}  ${preset.name}`).join('\n')
            );
          }
        }
      } catch (error) {
        return fail(
          error instanceof Error ? error.message : 'Command failed.'
        );
      }
      return fail(usage);
    }
  });

  // -------------------------------------------------------------------------
  // Background sync
  // -------------------------------------------------------------------------

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }

  bb.background.service('sync', {
    async start(signal) {
      while (!signal.aborted) {
        const api = await currentApi();
        if (api !== null) {
          const projectIds = store.configuredProjectIds();
          await Promise.all(
            projectIds.map(projectId =>
              syncProject(projectId).catch(error => {
                bb.log.warn(`sync loop: ${safeMessage(error)}`);
                return null;
              })
            )
          );
        }
        await sleep(SYNC_INTERVAL_MS, signal);
      }
    }
  });

  bb.onDispose(() => {
    invalidateConnection();
    bb.log.info('disposed');
  });

  // Exported for tests and for the settings page's "connect" affordance.
  return { requestConnectionInput };
}
