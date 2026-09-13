// Pure Trello JSON -> domain mapping. No I/O, no dependencies: everything here
// is a function of the parsed response body, which is what makes it testable
// without touching the network.
import type {
  TrelloAttachment,
  TrelloBoard,
  TrelloCard,
  TrelloComment,
  TrelloList,
  TrelloMember,
  TrelloRecord,
  TrelloStateCategory
} from './types'

// ---------------------------------------------------------------------------
// Defensive coercers
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): TrelloRecord {
  return value && typeof value === 'object' ? (value as TrelloRecord) : {}
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return fallback
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function asBoolean(value: unknown): boolean {
  return value === true
}

// ---------------------------------------------------------------------------
// Body helpers
// ---------------------------------------------------------------------------

/**
 * Why this is near-identity: a Trello card's `desc` and a comment action's
 * `data.text` are already markdown — there is no rich-text/HTML layer to
 * collapse. The only work left is normalising whitespace so the board and the
 * agent context block render predictably.
 */
export function bodyToMarkdown(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** The reverse trip is a true identity: Trello stores what it is sent. */
export function markdownToBody(text: string): string {
  return text.replace(/\r\n/gu, '\n')
}

// ---------------------------------------------------------------------------
// State category (derived, because Trello has no status field)
// ---------------------------------------------------------------------------

const DONE_LIST_NAME = /\b(done|complete[d]?|closed|shipped|released|archive[d]?)\b/iu
const IN_PROGRESS_LIST_NAME =
  /\b(doing|in progress|progress|wip|review|testing|qa|blocked)\b/iu

/**
 * Why a name heuristic: Trello lists carry no state whatsoever, so the only
 * signal a board offers is what the team called the column. First match wins;
 * anything unrecognised is 'todo' so the board tone is always defined. The
 * guess is correctable per list — see `cardStateCategory`'s `overrides`.
 */
export function listStateCategory(name: string): TrelloStateCategory {
  const value = name.trim()
  if (DONE_LIST_NAME.test(value)) return 'done'
  if (IN_PROGRESS_LIST_NAME.test(value)) return 'in_progress'
  return 'todo'
}

/**
 * The card's effective state category:
 *   1. a card Trello itself calls finished (`dueComplete`, or archived) is done
 *      regardless of which list it sits in,
 *   2. otherwise the board's manual per-list override wins,
 *   3. otherwise the list-name heuristic.
 */
export function cardStateCategory(
  card: Pick<TrelloCard, 'status' | 'dueComplete' | 'closed'>,
  overrides: Readonly<Record<string, TrelloStateCategory>> = {}
): TrelloStateCategory {
  if (card.dueComplete || card.closed) return 'done'
  // Why hasOwn: a plain-object lookup on a list id like `constructor` walks
  // the prototype chain and hands back a function.
  const override = Object.hasOwn(overrides, card.status.id)
    ? overrides[card.status.id]
    : undefined
  return override ?? listStateCategory(card.status.name)
}

// ---------------------------------------------------------------------------
// Entity mappers
// ---------------------------------------------------------------------------

export function mapMember(record: unknown): TrelloMember | undefined {
  const data = asRecord(record)
  const id = asString(data.id)
  if (!id) {
    return undefined
  }
  const avatarUrl = asString(data.avatarUrl)
  return {
    id,
    name:
      asString(data.fullName).trim() ||
      asString(data.username).trim() ||
      'Unknown member',
    username: asString(data.username) || undefined,
    // Why the suffix: Trello returns an avatar base path, not a usable image.
    avatarUrl: avatarUrl ? `${avatarUrl}/170.png` : undefined
  }
}

export function mapBoard(record: unknown): TrelloBoard {
  const data = asRecord(record)
  return {
    id: asString(data.id),
    name: asString(data.name, 'Untitled board'),
    url: asString(data.url) || asString(data.shortUrl) || undefined
  }
}

export function mapList(record: unknown): TrelloList {
  const data = asRecord(record)
  const name = asString(data.name, 'Untitled list')
  return {
    id: asString(data.id),
    name,
    pos: asFiniteNumber(data.pos) ?? 0,
    stateCategory: listStateCategory(name)
  }
}

/** Label names are optional in Trello; an unnamed label is known by its colour. */
export function mapLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(entry => {
      const label = asRecord(entry)
      return (asString(label.name).trim() || asString(label.color).trim()).trim()
    })
    .filter(label => label !== '')
}

/**
 * Why the id is parsed: Trello never returns a card's creation time, but the
 * first 8 hex characters of every Trello id are its creation timestamp in
 * seconds. Falls back to now when the id is not a Trello ObjectId.
 */
export function createdAtFromId(id: string, fallback: string): string {
  if (!/^[0-9a-f]{8}/iu.test(id)) return fallback
  const seconds = Number.parseInt(id.slice(0, 8), 16)
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback
  return new Date(seconds * 1000).toISOString()
}

/** Trello's `due` is a full datetime; the board only ever shows the date. */
export function dueDateFromIso(value: unknown): string | undefined {
  const raw = asString(value)
  if (!raw) return undefined
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return undefined
  return new Date(parsed).toISOString().slice(0, 10)
}

/**
 * Maps one `commentCard` action. Why the odd field names: Trello models a
 * comment as an action, so its author is `memberCreator` and its text is
 * nested under `data.text`.
 */
export function mapComment(record: unknown): TrelloComment {
  const data = asRecord(record)
  const id = asString(data.id)
  const now = new Date().toISOString()
  return {
    id,
    body: bodyToMarkdown(asRecord(data.data).text),
    createdAt: asString(data.date) || createdAtFromId(id, now),
    updatedAt: asString(data.dateLastEdited) || undefined,
    user: mapMember(data.memberCreator),
    attachments: []
  }
}

export function mapAttachment(record: unknown): TrelloAttachment {
  const data = asRecord(record)
  const id = asString(data.id)
  const contentType = asString(data.mimeType)
  const previews = Array.isArray(data.previews) ? data.previews : []
  // Trello orders previews smallest-first; the first one is the thumbnail.
  const thumbUrl = asString(asRecord(previews[0]).url)
  const name = asString(data.name, 'Untitled attachment')
  return {
    id,
    name,
    contentType,
    size: asFiniteNumber(data.bytes) ?? 0,
    url: asString(data.url),
    thumbUrl: thumbUrl || undefined,
    // Why the name fallback: Trello leaves `mimeType` empty for plenty of
    // uploads, so the extension is the only signal left.
    isImage:
      contentType.startsWith('image/') ||
      (contentType === '' && /\.(png|jpe?g|gif|webp|svg|bmp)$/iu.test(name)),
    createdAt: asString(data.date) || createdAtFromId(id, new Date().toISOString()),
    attachedTo: 'card'
  }
}

export function cardUrl(record: TrelloRecord): string {
  const shortUrl = asString(record.shortUrl) || asString(record.url)
  if (shortUrl) return shortUrl
  const shortLink = asString(record.shortLink)
  return shortLink ? `https://trello.com/c/${encodeURIComponent(shortLink)}` : ''
}

/**
 * `context.lists` resolves a card's `idList` to a real list name without an
 * N+1 call; a card read on its own carries an embedded `list` object instead.
 * Neither is guessed — an unresolvable list degrades to a placeholder rather
 * than inventing a name.
 */
export function mapCard(
  raw: unknown,
  context?: {
    lists?: ReadonlyMap<string, TrelloList>
    board?: TrelloBoard
  }
): TrelloCard {
  const data = asRecord(raw)
  const id = asString(data.id)
  const now = new Date().toISOString()
  const idShort = asFiniteNumber(data.idShort)
  const listId = asString(data.idList)
  const status =
    context?.lists?.get(listId) ??
    (asString(asRecord(data.list).id)
      ? mapList(data.list)
      : { id: listId, name: 'Unknown list', pos: 0, stateCategory: 'todo' as const })

  const board =
    context?.board ??
    (asString(asRecord(data.board).id)
      ? mapBoard(data.board)
      : { id: asString(data.idBoard), name: '' })

  const memberIds = asStringArray(data.idMembers)
  // Why the first member: Trello cards have a member set, this plugin's board
  // model has one assignee. The rest stay visible through `memberIds`.
  const members = Array.isArray(data.members) ? data.members : []
  const assignee =
    mapMember(members.find(entry => asString(asRecord(entry).id) === memberIds[0])) ??
    mapMember(members[0])

  const closed = asBoolean(data.closed)
  const dueComplete = asBoolean(data.dueComplete)

  return {
    id,
    idShort: idShort ?? undefined,
    key: `#${idShort ?? id}`,
    title: asString(data.name, id ? `#${idShort ?? id}` : 'Untitled card'),
    description: bodyToMarkdown(data.desc),
    url: cardUrl(data),
    boardId: board.id,
    board,
    status,
    stateCategory: cardStateCategory({ status, closed, dueComplete }),
    closed,
    dueComplete,
    assignee,
    assigneeId: assignee?.id ?? memberIds[0],
    memberIds,
    labels: mapLabels(data.labels),
    dueDate: dueDateFromIso(data.due),
    createdAt: createdAtFromId(id, now),
    updatedAt: asString(data.dateLastActivity) || createdAtFromId(id, now)
  }
}
