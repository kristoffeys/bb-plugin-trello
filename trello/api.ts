// The Trello operations the rest of the plugin uses, built on the transport in
// client.ts. Everything returns domain types from types.ts and throws
// TrelloApiError on any non-2xx.
import {
  TrelloApiError,
  createTransport,
  type TrelloCredentials
} from './client'
import {
  asRecord,
  asString,
  cardUrl,
  mapAttachment,
  mapBoard,
  mapCard,
  mapComment,
  mapList,
  mapMember,
  markdownToBody
} from './mapper'
import type {
  TrelloAttachment,
  TrelloBoard,
  TrelloCard,
  TrelloCardUpdate,
  TrelloComment,
  TrelloCreateCardArgs,
  TrelloList,
  TrelloListCardsArgs,
  TrelloMember,
  TrelloRecord
} from './types'

/** The card fields the board needs; anything else is dead weight on the wire. */
const CARD_FIELDS =
  'id,idShort,name,desc,due,dueComplete,closed,idList,idBoard,idMembers,labels,shortUrl,dateLastActivity'
/** Resolves member names inline so a board sync needs no N+1 member lookups. */
const MEMBER_FIELDS = 'id,fullName,username'

const DEFAULT_LIMIT = 100
/**
 * Ceiling for a whole-board sync, applied client-side to the one response
 * Trello sends. A board with more than 5000 cards in scope is not a board
 * anybody reads, and `listCards` reports the overflow rather than hiding it.
 */
export const BOARD_CARD_LIMIT = 5000

function clampLimit(limit: number | undefined): number {
  return Math.min(
    Math.max(1, Number.isFinite(limit) ? Number(limit) : DEFAULT_LIMIT),
    BOARD_CARD_LIMIT
  )
}

function sortAndLimitCards(cards: TrelloCard[], limit: number): TrelloCard[] {
  return cards
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

/** A mutation's parameters, empty values included — `desc=` clears a body. */
function mutationQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

/** A file on its way to a card. */
export interface TrelloAttachmentUpload {
  name: string
  /** '' is allowed — Trello then sniffs the type itself. */
  contentType: string
  bytes: Uint8Array
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: 'text/csv',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp',
  zip: 'application/zip'
}

/**
 * A content type guessed from a filename.
 *
 * Only what a ticket attachment is actually likely to be: Trello uses the type
 * to decide whether a card shows a preview, and an unknown type degrades to a
 * plain download rather than to a failure, so a full mime database would buy
 * nothing.
 */
export function contentTypeForName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

export interface TrelloCardPage {
  /** Cards in scope, newest-updated first, capped at the caller's limit. */
  cards: TrelloCard[]
  /** How many cards matched the scope before the limit truncated them. */
  matchedCount: number
}

export interface TrelloApi {
  /** The member the token belongs to — Trello's answer to "who am I". */
  getViewer(): Promise<TrelloMember | null>

  /** Cards on one board, newest-updated first. */
  listCards(args: TrelloListCardsArgs): Promise<TrelloCardPage>
  /** A single card, or null when Trello has no card with that id. */
  getCard(cardId: string): Promise<TrelloCard | null>
  createCard(args: TrelloCreateCardArgs): Promise<TrelloCard>
  updateCard(cardId: string, updates: TrelloCardUpdate): Promise<TrelloCard>
  addCardComment(cardId: string, body: string): Promise<TrelloComment>
  getCardComments(cardId: string): Promise<TrelloComment[]>
  listCardAttachments(cardId: string): Promise<TrelloAttachment[]>
  /** Upload one file to a card. Trello caps size per plan (10MB on free). */
  addCardAttachment(
    cardId: string,
    file: TrelloAttachmentUpload
  ): Promise<TrelloAttachment>

  /** Open boards the token can see. */
  listBoards(args?: { query?: string; limit?: number }): Promise<TrelloBoard[]>
  /** A board's open lists, in Trello's own left-to-right `pos` order. */
  listLists(boardId: string): Promise<TrelloList[]>
  /** Members who can be put on a card on this board. */
  listBoardMembers(boardId: string): Promise<TrelloMember[]>
}

export function createTrelloApi(
  credentials: TrelloCredentials,
  options?: { fetchImpl?: typeof fetch }
): TrelloApi {
  const transport = createTransport(credentials, options)

  async function listLists(boardId: string): Promise<TrelloList[]> {
    if (!boardId) return []
    const records = await transport.fetchAll(
      `/boards/${encodeURIComponent(boardId)}/lists?filter=open&fields=id,name,pos`
    )
    // Why sort: `pos` is a sparse float Trello reorders by, and the response
    // order is not contractually the board order.
    return records.map(mapList).sort((a, b) => a.pos - b.pos)
  }

  async function listsById(boardId: string): Promise<Map<string, TrelloList>> {
    return new Map((await listLists(boardId)).map(list => [list.id, list]))
  }

  async function getCard(cardId: string): Promise<TrelloCard | null> {
    const response = await transport.request<TrelloRecord>(
      `/cards/${encodeURIComponent(cardId)}?fields=${CARD_FIELDS}` +
        `&members=true&member_fields=${MEMBER_FIELDS}` +
        '&list=true&board=true&board_fields=id,name,url'
    )
    const data = asRecord(response)
    if (!asString(data.id)) {
      return null
    }
    return mapCard(data)
  }

  /** Re-read a card after a mutation so callers always get Trello's own view. */
  async function reloadCard(cardId: string): Promise<TrelloCard> {
    const card = await getCard(cardId)
    if (!card) {
      throw new TrelloApiError(`Trello card ${cardId} could not be read back.`, null)
    }
    return card
  }

  return {
    async getViewer(): Promise<TrelloMember | null> {
      const response = await transport.request<TrelloRecord>(
        `/members/me?fields=${MEMBER_FIELDS},avatarUrl`
      )
      return mapMember(response) ?? null
    },

    async listCards(args: TrelloListCardsArgs): Promise<TrelloCardPage> {
      if (!args.boardId) return { cards: [], matchedCount: 0 }
      const limit = clampLimit(args.limit)
      // Why filter values: the board-cards filter is a PATH SEGMENT taking
      // all/open/closed/visible/none — 'closed' means archived.
      const filter =
        args.status === 'all' ? 'all' : args.status === 'closed' ? 'closed' : 'open'
      const lists = await listsById(args.boardId)
      // Why one request: GET /boards/{id}/cards/{filter} documents no query
      // parameters at all — no limit, no cursor — and answers with the whole
      // collection. The `before` cursor of the guide is a DATE filter, not a
      // position, and board order is not creation order, so walking it drops
      // cards. There is nothing to page through.
      const records = await transport.fetchAll(
        `/boards/${encodeURIComponent(args.boardId)}/cards/${filter}` +
          `?fields=${CARD_FIELDS}` +
          `&members=true&member_fields=${MEMBER_FIELDS}`
      )
      // Why client-side: the board-cards route has no list or member filter,
      // and the whole board is already in hand, so narrowing costs nothing
      // extra. It also runs BEFORE the limit, so a narrow scope is never
      // truncated by cards outside it.
      const cards = records
        .map(record => mapCard(record, { lists }))
        .filter(card => args.listId === undefined || card.status.id === args.listId)
        .filter(card => args.memberId === undefined || card.memberIds.includes(args.memberId))
      return { cards: sortAndLimitCards(cards, limit), matchedCount: cards.length }
    },

    getCard,

    async createCard(args: TrelloCreateCardArgs): Promise<TrelloCard> {
      const title = args.title.trim()
      if (!title) {
        throw new TrelloApiError('A card title is required.')
      }
      if (!args.listId) {
        throw new TrelloApiError('A Trello list is required to create a card.')
      }
      const params: Record<string, string> = { idList: args.listId, name: title }
      if (args.description?.trim()) {
        params.desc = markdownToBody(args.description.trim())
      }
      if (args.assigneeId) {
        params.idMembers = args.assigneeId
      }
      if (args.dueDate) {
        params.due = args.dueDate
      }
      const response = await transport.request<TrelloRecord>(
        `/cards?${mutationQuery(params)}`,
        { method: 'POST' }
      )
      const data = asRecord(response)
      const id = asString(data.id)
      if (!id) {
        throw new TrelloApiError('Trello did not return an id for the created card.')
      }
      // The POST echo carries no member or list objects, so read the card back
      // for resolved names.
      return (await getCard(id)) ?? mapCard(data)
    },

    async updateCard(cardId: string, updates: TrelloCardUpdate): Promise<TrelloCard> {
      const params: Record<string, string> = {}
      if (updates.title !== undefined) {
        params.name = updates.title
      }
      if (updates.description !== undefined) {
        params.desc = updates.description ? markdownToBody(updates.description) : ''
      }
      if (updates.listId !== undefined) {
        // Why this is the whole status change: Trello has no transition model,
        // so moving a card between lists is all a "status move" ever is.
        params.idList = updates.listId
      }
      if (updates.assigneeId !== undefined && updates.assigneeId !== null) {
        // Why a replace and not an add: `idMembers` on PUT sets the card's
        // whole member set, and this plugin models one assignee.
        params.idMembers = updates.assigneeId
      }
      // Why not `idMembers=`: Trello types idMembers as a list of ids and
      // documents no empty form for it; removal has its own route.
      const clearAssignee = updates.assigneeId === null
      if (Object.keys(params).length === 0 && !clearAssignee) {
        return reloadCard(cardId)
      }
      if (Object.keys(params).length > 0) {
        await transport.request(
          `/cards/${encodeURIComponent(cardId)}?${mutationQuery(params)}`,
          { method: 'PUT' }
        )
      }
      if (clearAssignee) {
        const current = await getCard(cardId)
        for (const memberId of current?.memberIds ?? []) {
          await transport.request(
            `/cards/${encodeURIComponent(cardId)}/idMembers/${encodeURIComponent(memberId)}`,
            { method: 'DELETE' }
          )
        }
      }
      return reloadCard(cardId)
    },

    async addCardComment(cardId: string, body: string): Promise<TrelloComment> {
      const response = await transport.request<TrelloRecord>(
        `/cards/${encodeURIComponent(cardId)}/actions/comments?${mutationQuery({
          text: markdownToBody(body)
        })}`,
        { method: 'POST' }
      )
      return mapComment(response)
    },

    async getCardComments(cardId: string): Promise<TrelloComment[]> {
      // Why `filter=commentCard`: /cards/{id}/actions is the card's whole
      // activity feed — moves, member changes, everything — and only the
      // commentCard actions are comments.
      const records = await transport.fetchAll(
        `/cards/${encodeURIComponent(cardId)}/actions?filter=commentCard&limit=1000` +
          `&memberCreator=true&memberCreator_fields=${MEMBER_FIELDS}`
      )
      return records
        .map(mapComment)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    },

    async listCardAttachments(cardId: string): Promise<TrelloAttachment[]> {
      const records = await transport.fetchAll(
        `/cards/${encodeURIComponent(cardId)}/attachments` +
          '?fields=id,name,mimeType,bytes,url,previews,date'
      )
      return records.map(mapAttachment)
    },

    async addCardAttachment(
      cardId: string,
      file: TrelloAttachmentUpload
    ): Promise<TrelloAttachment> {
      const name = file.name.trim()
      if (!name) {
        throw new TrelloApiError('An attachment needs a filename.')
      }
      const form = new FormData()
      // A Blob rather than the raw bytes: the multipart part needs a length and
      // a filename, and Trello rejects a `file` part that carries neither.
      form.append(
        'file',
        // Cast: lib.dom types BlobPart as ArrayBuffer-backed only, while a
        // Buffer from readFile is Uint8Array<ArrayBufferLike>. Copying it just
        // to satisfy that would duplicate every attachment in memory.
        new Blob([file.bytes as BlobPart], {
          type: file.contentType || contentTypeForName(name)
        }),
        name
      )
      form.append('name', name)
      const response = await transport.request<TrelloRecord>(
        `/cards/${encodeURIComponent(cardId)}/attachments`,
        { method: 'POST', body: form }
      )
      return mapAttachment(asRecord(response))
    },

    async listBoards(args: { query?: string; limit?: number } = {}): Promise<TrelloBoard[]> {
      const records = await transport.fetchAll(
        '/members/me/boards?filter=open&fields=id,name,url'
      )
      // Why client-side: /members/me/boards has no query parameter, and the
      // response is the full (small) set of boards the token can see anyway.
      const query = args.query?.trim().toLocaleLowerCase() ?? ''
      const boards = records
        .map(mapBoard)
        .filter(board => query === '' || board.name.toLocaleLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name))
      return args.limit === undefined ? boards : boards.slice(0, args.limit)
    },

    listLists,

    async listBoardMembers(boardId: string): Promise<TrelloMember[]> {
      if (!boardId) return []
      const records = await transport.fetchAll(
        `/boards/${encodeURIComponent(boardId)}/members?fields=${MEMBER_FIELDS}`
      )
      return records
        .map(record => mapMember(record))
        .filter((member): member is TrelloMember => member !== undefined)
    }
  }
}

export { cardUrl }
