// Trello REST transport. Credentials are passed in per call site — this layer
// never reads or writes them anywhere.
//
// Why this file is more paranoid than a header-auth client: Trello takes both
// credentials as QUERY PARAMETERS (`?key=…&token=…`), so any error message
// that echoes a request URL leaks them. `scrub` therefore redacts the literal
// values AND strips `key=`/`token=` from any URL that survives into a message.
import type { TrelloRecord } from './types'
import { asRecord, asString } from './mapper'

const TRELLO_API_BASE = 'https://api.trello.com/1'
const RATE_LIMIT_MAX_RETRIES = 4
const RATE_LIMIT_BASE_DELAY_MS = 500
const RATE_LIMIT_MAX_DELAY_MS = 10_000

export interface TrelloCredentials {
  /** The application key from trello.com/power-ups/admin. */
  apiKey: string
  /** The per-user token minted through /1/authorize. */
  apiToken: string
}

export class TrelloApiError extends Error {
  readonly status: number | null
  /** From a Retry-After header, on the rare occasions Trello sends one. */
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    status: number | null = null,
    retryAfterMs: number | null = null
  ) {
    super(message)
    this.name = 'TrelloApiError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export function isRateLimited(error: unknown): boolean {
  if (!(error instanceof TrelloApiError)) return false
  // Why the body check too: Trello's 429 body names which ceiling was hit
  // (API_KEY_LIMIT_EXCEEDED / API_TOKEN_LIMIT_EXCEEDED), and the same text has
  // been observed on other statuses behind proxies.
  return error.status === 429 || /rate limit|LIMIT_EXCEEDED/iu.test(error.message)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Retry-After is seconds or an HTTP date; both forms are accepted. */
export function retryAfterMs(response: {
  headers: { get(name: string): string | null }
}): number | null {
  const header = response.headers.get('retry-after')
  if (header === null) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - Date.now())
}

export function isAuthError(error: unknown): boolean {
  // Why: Trello answers a bad key or token with 401 ("invalid key",
  // "invalid token", "unauthorized permission requested"). A 403 means the
  // credential is fine but the board is not visible to it, which is not a
  // reason to tell the user to re-key the connection.
  return error instanceof TrelloApiError && error.status === 401
}

/** Which half of the credential pair Trello rejected, when its body says. */
export type CredentialFault = 'key' | 'token' | null

const INVALID_KEY_PATTERN = /invalid\s+(app\s+)?key/iu

/**
 * Trello's 401 body names the offending credential — "invalid key" versus
 * "invalid token" — which is the difference between "the Power-Up key is
 * wrong" and "reconnect to mint a new token". Without this the UI can only say
 * "one of these two is wrong", which is the ambiguity that costs people an
 * afternoon.
 *
 * Reads `error.message`, which the transport has ALREADY scrubbed, so no
 * credential can be reached through here.
 */
export function authFault(error: unknown): CredentialFault {
  if (!isAuthError(error)) return null
  const message = (error as TrelloApiError).message
  if (INVALID_KEY_PATTERN.test(message)) return 'key'
  // "unauthorized permission requested" is what a token lacking a scope gets;
  // the key is fine in that case.
  if (
    /invalid\s+(app\s+)?token|token\s+not\s+valid|unauthorized permission/iu.test(message)
  ) {
    return 'token'
  }
  return null
}

/** Redacts `key=`/`token=` values in any URL that reaches a message. */
export function stripCredentialQueryParams(message: string): string {
  return message.replace(
    /([?&])(key|token)=[^&\s"'<>)\]]*/giu,
    (_match, separator: string, name: string) => `${separator}${name}=[redacted]`
  )
}

/**
 * Trello's verdict on which credential is wrong, corrected by one extra probe.
 *
 * Why: a token that does not belong to the key is reported as "invalid key" —
 * the same key on its own answers "invalid token" (400). Taking the 401 at
 * face value sends the user off to regenerate the credential that was fine, so
 * when both are configured and Trello blames the key, ask once more with the
 * key alone: still "invalid key" means the key really is bad, anything else
 * means the key is good and the token is the stale half.
 *
 * One request, no retry: a probe that cannot decide (unreachable, rate
 * limited) keeps Trello's original verdict rather than inventing one.
 */
export async function diagnoseCredentialFault(
  error: unknown,
  credentials: TrelloCredentials,
  options?: { fetchImpl?: typeof fetch }
): Promise<CredentialFault> {
  const fault = authFault(error)
  const apiKey = credentials.apiKey.trim()
  if (fault !== 'key' || apiKey === '' || credentials.apiToken.trim() === '') {
    return fault
  }
  const doFetch = options?.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return fault
  try {
    const response = await doFetch(
      withQueryParams(`${TRELLO_API_BASE}/members/me`, { key: apiKey }),
      { headers: { Accept: 'application/json' } }
    )
    if (response.ok) return 'token'
    const body = stripCredentialQueryParams(
      (await readTrelloError(response)).split(apiKey).join('[redacted]')
    )
    // A rate-limited probe says nothing about the credentials.
    if (isRateLimited(new TrelloApiError(body, response.status))) return fault
    return INVALID_KEY_PATTERN.test(body) ? 'key' : 'token'
  } catch {
    return fault
  }
}

export type RequestInitLite = { method?: string; body?: string }

export type TrelloTransport = {
  /** A single request. Returns null for a 204 or an empty body. */
  request<T>(path: string, init?: RequestInitLite): Promise<T | null>
  /** A collection endpoint that returns everything in one response. */
  fetchAll(path: string): Promise<TrelloRecord[]>
}

/** Append a query parameter to a path that may already have a query. */
export function withQueryParams(
  path: string,
  params: Record<string, string>
): string {
  const entries = Object.entries(params).filter(([, value]) => value !== '')
  if (entries.length === 0) return path
  const search = new URLSearchParams(entries).toString()
  return `${path}${path.includes('?') ? '&' : '?'}${search}`
}

async function readTrelloError(response: Response): Promise<string> {
  let body = ''
  try {
    body = (await response.text()).trim()
  } catch {
    // Fall through to status text.
  }
  if (body !== '') {
    // Why text-first: Trello answers most failures with a bare string
    // ("invalid token"), and only sometimes with a JSON envelope.
    try {
      const parsed: unknown = JSON.parse(body)
      const record = asRecord(parsed)
      const message = asString(record.message) || asString(record.error)
      if (message) return message
    } catch {
      // Not JSON — the raw text is the message.
    }
    return body.slice(0, 500)
  }
  return response.statusText || `Trello request failed (${response.status})`
}

export function createTransport(
  credentials: TrelloCredentials,
  options?: { fetchImpl?: typeof fetch }
): TrelloTransport {
  const apiKey = credentials.apiKey.trim()
  const apiToken = credentials.apiToken.trim()
  if (!apiKey || !apiToken) {
    throw new TrelloApiError('A Trello API key and API token are required.')
  }
  const doFetch = options?.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new TrelloApiError('No fetch implementation available.')
  }

  // Belt and braces: nothing this layer throws or logs may contain either
  // credential, whether it arrived as a literal or inside an echoed URL.
  const scrub = (message: string): string =>
    stripCredentialQueryParams(
      message.split(apiKey).join('[redacted]').split(apiToken).join('[redacted]')
    )

  /**
   * Trello allows 300 requests per 10s per key and 100 per 10s per token, and
   * answers a burst with 429. A board refresh fans out several requests at
   * once, so wait out a bounded number of attempts rather than surfacing a
   * hard error the user has to retry by hand.
   */
  async function requestWithRetry<T>(
    path: string,
    init?: RequestInitLite
  ): Promise<T | null> {
    let lastError: TrelloApiError | null = null
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
      try {
        return await requestOnce<T>(path, init)
      } catch (error) {
        if (!(error instanceof TrelloApiError) || !isRateLimited(error)) {
          throw error
        }
        lastError = error
        if (attempt === RATE_LIMIT_MAX_RETRIES) break
        // Full jitter: retrying a fanned-out burst in lockstep would just
        // rebuild the same burst.
        const backoff = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt
        const delay = error.retryAfterMs ?? Math.random() * backoff
        await sleep(Math.min(delay, RATE_LIMIT_MAX_DELAY_MS))
      }
    }
    throw (
      lastError ?? new TrelloApiError('Trello rate limit reached. Try again later.', 429)
    )
  }

  async function requestOnce<T>(path: string, init?: RequestInitLite): Promise<T | null> {
    const url = withQueryParams(`${TRELLO_API_BASE}${path}`, {
      key: apiKey,
      token: apiToken
    })
    let response: Response
    try {
      response = await doFetch(url, {
        method: init?.method,
        body: init?.body,
        headers: {
          Accept: 'application/json',
          ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' })
        }
      })
    } catch (error) {
      throw new TrelloApiError(
        scrub(
          `Could not reach Trello: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    }
    if (!response.ok) {
      throw new TrelloApiError(
        scrub(await readTrelloError(response)),
        response.status,
        retryAfterMs(response)
      )
    }
    if (response.status === 204) {
      return null
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw new TrelloApiError(
        scrub(
          `Trello returned an unreadable response: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        response.status
      )
    }
    if (text.trim() === '') return null
    try {
      return JSON.parse(text) as T
    } catch (error) {
      throw new TrelloApiError(
        scrub(
          `Trello returned an unreadable response: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        response.status
      )
    }
  }

  async function fetchAll(path: string): Promise<TrelloRecord[]> {
    // Why no paging: Trello's collections — lists, members, attachments,
    // actions and a board's cards — are not page-numbered and return the whole
    // set in one response.
    const response = await requestWithRetry<unknown>(path)
    return Array.isArray(response) ? response.map(entry => asRecord(entry)) : []
  }

  return { request: requestWithRetry, fetchAll }
}
