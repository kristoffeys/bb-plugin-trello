import { expect, test } from 'vitest';
import { createTrelloApi } from '../trello/index.js';

// Opt-in: this suite talks to a real Trello account. Run it with
//   TRELLO_API_KEY=... TRELLO_API_TOKEN=... \
//   TRELLO_LIVE_TEST=1 NODE_USE_ENV_PROXY=1 npx vitest run test/live-attach.test.ts
// Node's fetch ignores the proxy env vars without NODE_USE_ENV_PROXY=1.
const live = process.env.TRELLO_LIVE_TEST === '1';

function credentials() {
  return {
    apiKey: process.env.TRELLO_API_KEY ?? '',
    apiToken: process.env.TRELLO_API_TOKEN ?? ''
  };
}

/**
 * The generic live probe usually samples a card with no attachments, so it
 * never exercises the mapping. This one walks the boards until it finds a card
 * that genuinely has one and asserts the mapped shape — no hard-coded card id,
 * so it keeps working as the account's data changes.
 */
test.skipIf(!live)(
  'maps a real card attachment',
  { timeout: 180_000 },
  async () => {
    const api = createTrelloApi(credentials());
    const boards = await api.listBoards({ limit: 5 });

    for (const board of boards) {
      const { cards } = await api.listCards({ boardId: board.id, limit: 50 });
      for (const card of cards) {
        const attachments = await api.listCardAttachments(card.id);
        const mapped = attachments[0];
        if (!mapped) continue;

        expect(mapped.id).toBeTruthy();
        expect(mapped.name).toBeTruthy();
        expect(mapped.attachedTo).toBe('card');
        expect(mapped.url.startsWith('https://')).toBe(true);
        expect(mapped.isImage).toBe(
          mapped.contentType.startsWith('image/') ||
            (mapped.contentType === '' && /\.(png|jpe?g|gif|webp|svg|bmp)$/iu.test(mapped.name))
        );
        console.log('mapped attachment:', mapped.name, mapped.contentType, mapped.size);
        return;
      }
    }
    console.log('no card attachments reachable with this token; nothing to map');
  }
);
