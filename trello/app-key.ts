// The bundled Trello application key.
//
// TODO: paste the API key from https://trello.com/power-ups/admin here — open
// (or create) the Power-Up, go to its "API key" tab, and copy the key.
//
// Two things are needed on that same tab, not one. Trello refuses the flow
// with 400 "Invalid return_url. The return URL should match the application's
// allowed origins." until BB's own origin (e.g. http://127.0.0.1:38886, shown
// in the connection panel and by `bb trello connect --browser`) is listed
// under **Allowed origins**. "If your API key has no allowed origins set, then
// no redirect URL will work."
//
// While this is an empty string the plugin falls back to a user-supplied key
// (the `api-key` secret, written by the connection form or
// `bb trello connect --key-file`), and the UI asks for one when there is
// neither.
//
// ---------------------------------------------------------------------------
// Why shipping a key in the repo is safe here
// ---------------------------------------------------------------------------
// A Trello API key is a PUBLIC application identifier, not a secret. Every
// client-side Power-Up embeds its key in the browser, and Trello's own guide
// says so outright: "It is ok for your API key to be publicly available, but a
// token should never be publicly available."
//
// The sensitive half of a Power-Up is its **Secret** (used only by OAuth 1.0
// and for verifying Power-Up iframe callbacks). This plugin uses neither, so
// the Secret is not in this repo and is not needed by any code path here.
//
// What the key alone lets someone do is start an authorization prompt naming
// this application — which is exactly what we want it to do. It grants no
// access on its own; only a user-approved token does, and Trello will only
// redirect that token to an origin the key's owner allowlisted.
//
// A user who would rather not use the bundled key can paste their own; a
// user-supplied key always wins.
export const DEFAULT_TRELLO_API_KEY = '';

/**
 * Where the user goes to create a Power-Up, read its API key, and add BB's
 * origin to that key's allowed origins. Referenced by the UI and the CLI so
 * the address is written down once.
 */
export const TRELLO_POWER_UP_ADMIN_URL = 'https://trello.com/power-ups/admin';

/**
 * What to tell the user once the offending credential is known.
 *
 * The token case deliberately says nothing about allowed origins: that is a
 * separate failure, and mentioning it here sends the user to the Power-Up
 * admin page when all they need is to reconnect.
 */
export function authFaultMessage(
  fault: 'key' | 'token' | null,
  callbackOrigin: string
): string {
  switch (fault) {
    case 'key':
      return `Trello rejected the API key. Check it on ${TRELLO_POWER_UP_ADMIN_URL}, and that ${callbackOrigin || "BB's address"} is one of that key's allowed origins.`
    case 'token':
      return 'Trello rejected the API token — it is invalid or expired. Connect Trello again to mint a new one.'
    default:
      return 'Trello rejected the API key or token. Update the connection.'
  }
}

/**
 * Which API key is in force. A user-supplied key always wins over the bundled
 * default; null means there is no key at all, which is the state the UI has to
 * ask the user to fix.
 *
 * `bundled` is a parameter rather than read straight from the constant so the
 * empty-bundled-key path stays testable however this ships.
 */
export function resolveTrelloApiKey(
  userKey: string | null,
  bundled: string = DEFAULT_TRELLO_API_KEY
): string | null {
  const ownKey = userKey?.trim() ?? '';
  if (ownKey !== '') return ownKey;
  const fallback = bundled.trim();
  return fallback === '' ? null : fallback;
}
