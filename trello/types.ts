// Domain types for the Trello API layer. Trello authenticates with a pair —
// an application API key plus a per-user token — and both ride on every
// request, so everything below is scoped by the credentials handed to
// `createTrelloApi`.
//
// These are the API layer's OWN types; contract.ts owns the wire shapes
// (WorkItem etc.) and validates whatever server.ts derives from these.

export type TrelloRecord = Record<string, unknown>

/** Same three buckets contract.ts's workStateCategorySchema enumerates. */
export type TrelloStateCategory = 'todo' | 'in_progress' | 'done'

export type TrelloBoard = {
  id: string
  name: string
  /** The board's own browser URL, when the response carried one. */
  url?: string
}

/**
 * A Trello list — this plugin's "status". Trello has no status field, so the
 * list a card sits in IS its status, and `stateCategory` is guessed from the
 * list's name (see `listStateCategory` in mapper.ts).
 */
export type TrelloList = {
  id: string
  name: string
  /** Trello's fractional ordering value; the board's left-to-right lane order. */
  pos: number
  stateCategory: TrelloStateCategory
}

export type TrelloMember = {
  id: string
  name: string
  username?: string
  avatarUrl?: string
}

export type TrelloCard = {
  /** Trello card id — the locator used everywhere in the plugin. */
  id: string
  /** Per-board sequential counter, rendered as the key. */
  idShort?: number
  /** Human display identifier, e.g. "#412". */
  key: string
  title: string
  /** Trello's `desc` is already markdown, so this is the field verbatim. */
  description: string
  /** The card's `shortUrl`. */
  url: string
  boardId: string
  board: TrelloBoard
  /** The card's list, standing in for a workflow status. */
  status: TrelloList
  /** Resolved from the list name plus the card's own done flags. */
  stateCategory: TrelloStateCategory
  closed: boolean
  dueComplete: boolean
  /** The first of the card's members; Trello cards can carry several. */
  assignee?: TrelloMember
  assigneeId?: string
  /** Every member on the card, in Trello's order. */
  memberIds: string[]
  labels: string[]
  /** ISO date, YYYY-MM-DD, derived from the card's `due` datetime. */
  dueDate?: string
  createdAt: string
  updatedAt: string
}

export type TrelloAttachment = {
  id: string
  name: string
  /** e.g. "image/png"; '' when Trello omits it. */
  contentType: string
  /** Bytes; 0 when unknown (Trello reports null for link attachments). */
  size: number
  /** Opens in a logged-in browser — see contract.ts's workAttachmentSchema. */
  url: string
  thumbUrl?: string
  isImage: boolean
  createdAt: string
  attachedTo: 'card'
}

export type TrelloComment = {
  id: string
  body: string
  createdAt: string
  updatedAt?: string
  user?: TrelloMember
  /** Always empty: Trello attaches files to cards, never to comment actions. */
  attachments: TrelloAttachment[]
}

export type TrelloCardStatusFilter = 'open' | 'closed' | 'all'

export type TrelloListCardsArgs = {
  boardId: string
  /** Narrow to one list; filtered client-side after mapping. */
  listId?: string
  /** Narrow to cards this member is on; filtered client-side after mapping. */
  memberId?: string
  status?: TrelloCardStatusFilter
  limit?: number
}

export type TrelloCreateCardArgs = {
  /** Required: Trello has nowhere to put a card that is not in a list. */
  listId: string
  title: string
  /** Markdown, stored verbatim in the card's `desc`. */
  description?: string
  /** Sets the card's member set to just this member. */
  assigneeId?: string
  /** ISO date, YYYY-MM-DD. */
  dueDate?: string
}

export type TrelloCardUpdate = {
  /** Moves the card between lists — this plugin's status change. */
  listId?: string
  title?: string
  /** Markdown, stored verbatim. `null` clears the body. */
  description?: string | null
  /** Replaces the card's whole member set; `null` clears it. */
  assigneeId?: string | null
}
