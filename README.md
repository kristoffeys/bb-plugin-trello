# Trello for BB

Brings each BB project's [Trello](https://trello.com) cards into one focused
board — a list and kanban view, card detail with comments, list and member
changes, card creation, saved filter presets, `@`/`#` mentions in the composer,
and a `bb trello` CLI for agents.

Modelled on the Taskboard plugin, but single-provider: one Trello API key and
token serve the whole install, and each BB project is mapped to one Trello
board.

## Install

```
bb plugin install git:https://github.com/kristoffeys/bb-plugin-trello.git
```

Needs `npm` on PATH: BB clones the repo, installs production dependencies, and
builds the server and app bundles.

## Setup

Trello authenticates with a **pair** of credentials — an application API key
and a per-user token — and both are required on every request. The API key is
an application identifier; only the token is per-user. So the key is set up
once, and connecting is then one click.

### One-click (the normal path)

1. Click **Connect Trello** in the Trello panel. BB opens Trello in your
   browser, you approve the request, and the token is stored for you — you
   never see or paste it.
2. Map the BB project to a Trello board in the panel's manage view.

Headless equivalent, which prints the URL for you to open yourself:

```
bb trello connect --browser
```

### Providing the API key

This repo ships an API key in `trello/app-key.ts`. If that constant is empty
(or you would rather authorise against your own Power-Up), the panel asks for a
key and links you to the right page. To create one:

1. Open **https://trello.com/power-ups/admin** and create (or open) a Power-Up.
2. Copy the key from its **API key** tab.
3. On that same tab, add BB's own origin — shown in the connection panel and by
   `bb trello connect --browser`, e.g. `http://127.0.0.1:38886` — under
   **Allowed origins**. Trello blocks the authorization redirect otherwise:
   *"If your API key has no allowed origins set, then no redirect URL will
   work."* This is the step that is easy to miss; without it Trello answers
   `400 Invalid return_url`.
4. Paste the key into the panel, or:

   ```
   bb trello connect --key-file <path-to-a-file-with-the-key>
   ```

A key you supply always overrides the bundled one.

### Fully manual (scripted or headless installs)

The original copy-paste path still works, and is the way to script this:

```
bb trello connect --key-file <path-to-a-file-with-the-key> \
                  --token-file <path-to-a-file-with-the-token>
```

A plugin CLI command runs inside the BB server, so it has no stdin to pipe a
secret through — both credentials are passed as file paths so they never land
in argv, shell history, or an agent transcript. Delete the files afterwards.
Either flag may be given on its own. To mint a token by hand, follow the
**Token** link on the Power-Up's API key tab.

Then map the BB project to a Trello board in the panel's manage view, or from
the shell:

```
bb trello config --board <trello-board-id>
```

Both credentials are stored in `0600` files under the plugin's data directory,
not in plugin settings, so changing them does not require a plugin reload. A
user-supplied key is kept out of error messages alongside the token because
Trello sends both as **query parameters**, and the plugin scrubs
`key=`/`token=` out of every error message it produces.

### Chat composer action

The **Turn prompt into Trello card** action is enabled by default. To remove it
from thread and new-thread chat composers, open **Settings → Plugins → Trello**
and turn off **Show “Turn prompt into Trello card” in the chat composer**. This
is an install-wide plugin preference; it does not alter the Trello connection
or any project’s board mapping and board-view settings.

`bb trello disconnect` removes the stored key and token and cancels any
authorization that is still in flight.

### How the browser flow works, and why it is safe

Trello has no OAuth 2.0 and returns the minted token in the **URL fragment**,
which browsers never send to a server. So the callback route serves a small
static page whose script reads the token out of `location.hash` and posts it
back to BB. Two routes are involved, and the reasoning is written out in
`trello/browser-auth.ts`:

- `GET …/http/auth/callback` is unauthenticated, because a redirect from
  trello.com is a plain browser navigation that cannot carry BB's auth. It
  answers one fixed byte string, reflects nothing from the request, and reads
  and writes nothing.
- `POST …/http/auth/complete` is the route that can write a credential, so it
  uses BB's `local` auth — a foreign page cannot reach it, since a form cannot
  send `application/json` and a `fetch` that does forces a preflight BB refuses
  for a non-local origin. On top of that, every callback must present a
  single-use state nonce (32 random bytes, 5 minute TTL, compared in constant
  time). That nonce is the barrier against anything else already running on the
  machine, so it is checked before the token is even looked at.

The token is verified against `GET /1/members/me` before it is stored, and no
token ever appears in a response body, an error message, or a log line.

There is no "who am I" field to fill in: the connected member is resolved from
`GET /1/members/me`, which is what powers the "only show cards I am a member of"
board option.

## Mapping

| Trello | This plugin |
| --- | --- |
| Board | The external project a BB project maps to |
| Card | Board item (`locator` = card id, `key` = `#<idShort>`) |
| List | Status — the card's list name and id, and the board's kanban lane |
| Card labels | Labels (a label's name, or its colour when unnamed) |
| Card members | Assignee — the first member; setting one replaces the set |
| `due` | Due date, rendered as `YYYY-MM-DD` |
| `desc` | Description — already markdown, stored verbatim |

Trello cards have no priority field, so the board has no priority column or
filter. There is no lane dimension beyond the list, because a Trello list is
simultaneously a card's status and the board's column.

### Todo / in progress / done is a guess you can correct

Trello has no status field and no notion of "this column means done" — a list
is just a named column. So each list's state category is **derived from its
name**, case-insensitively:

- `done` for `done`, `complete`, `completed`, `closed`, `shipped`, `released`,
  `archive`, `archived`
- `in_progress` for `doing`, `in progress`, `progress`, `wip`, `review`,
  `testing`, `qa`, `blocked`
- `todo` for everything else

A card Trello itself calls finished — `dueComplete`, or archived — is always
`done` regardless of which list it is in.

When the guess is wrong (an "Icebox" list that really means abandoned, a "Ready
for pickup" list that really means in progress), fix it in **Manage → Board
mapping → List states**: each list gets a three-way picker, and the override is
stored per board alongside the mapping. Lists you have not touched keep
following the heuristic.

## CLI

```
bb trello status
bb trello list [--query <text>] [--state todo|in_progress|done] [--cached]
bb trello show <locator>
bb trello start <locator> [--worktree]
bb trello lists
bb trello move <locator> --status <list-id>
bb trello comment <locator> <text>
bb trello edit <locator> [--title <text>] [--description <text>]
bb trello create --title <text> --list <list-id> [--description <text>]
                 [--assignee <member-id>] [--due <YYYY-MM-DD>]
                 [--attach <file>]...
bb trello refresh
bb trello config [--board <id>] [--assigned-to-me on|off] [--include-closed on|off]
bb trello connect [--key-file <path> --token-file <path>]
bb trello disconnect
bb trello presets list
```

Every command takes `--project <proj_id>` to target another BB project and
`--json` for machine-readable output. Cards are addressed by their Trello card
id (the `locator`), not the `#number` key — the key is only unique within a
board.

`bb trello lists` prints the list ids `move` and `create` take, along with each
list's state category and whether it is the guess or an override.

## The board

- Map a BB project to a Trello board, then correct any list whose state the
  heuristic got wrong.
- Kanban lanes are the board's lists, in Trello's own `pos` order — the same
  left-to-right order you see in Trello itself.
- Dragging a card between lanes moves it between lists. There is no transition
  model in Trello, so every list on the board is a valid destination for every
  card on it.
- Filter by list, member, state, and labels, and save those as named presets.

## Working on a card

`bb trello start <locator>`, or the **Start agent** button on a card, opens a
new BB thread in the project the board is mapped to, with the card's fields as
context. Nothing is written back to Trello.

Add `--worktree` (or use the split button on the card detail page) to give the
thread its own git worktree off the project's default branch, so two tickets
worked in parallel never collide in one checkout.

## Attachments

`bb trello create --attach <file>` uploads local files to the new card, one
`--attach` per file. They go up one at a time, after the card exists — Trello
has no call that creates a card and its files together. A file that will not
upload is reported as a warning and never takes the card down with it; Trello's
own size ceiling applies (10MB per file on free plans).

Downloading is a different story. Trello serves attachment files from
`trello.com` behind the uploader's board permissions, and fetching them would
mean streaming private bytes through the plugin. The board therefore lists
attachment names, types, and sizes, and opens the file in your browser, where
your Trello session authenticates it. Images are not inlined.

## Rate limits

Trello allows 300 requests per 10 seconds per API key and 100 per 10 seconds per
token, and answers a burst with `429`. The transport retries a bounded number of
times with full jitter, and honours `Retry-After` on the occasions Trello sends
one. A whole-board sync is one request for the lists plus one per 1000 cards.

## Agent safety

Card titles, descriptions, and comments are untrusted external text. Everything
this plugin hands to an agent — mention context, `bb trello show`, the handoff
prompt — is wrapped in a quoted, delimited block with an explicit instruction
not to follow anything inside it. See `formatWorkItemContext` in `contract.ts`.

## Development

```
npm install --include=dev
npx tsc --noEmit
npx vitest run
bb plugin build
bb plugin install .
bb plugin dev          # rebuild + reload on save
```

The two live-probe suites talk to a real Trello account and are skipped unless
`TRELLO_LIVE_TEST=1` is set alongside `TRELLO_API_KEY` and `TRELLO_API_TOKEN`.

## Layout

| File | Role |
| --- | --- |
| `contract.ts` | Wire contract: zod schemas, RPC methods, realtime channels, agent-facing formatting |
| `server.ts` | RPC handlers, background sync, CLI, mention provider, connection interaction |
| `store.ts` | SQLite cache: cards, sync state, board mapping, list overrides, board settings, filter presets |
| `trello/` | Trello REST client, entity mapper, and typed API surface |
| `app.tsx` | Board UI: nav panel, thread panel, list, kanban, detail, create dialog, settings |
| `board-settings.ts`, `filter-presets.ts` | Per-project board view state and saved filters |
| `skills/trello/` | The skill that teaches agents to use `bb trello` |
