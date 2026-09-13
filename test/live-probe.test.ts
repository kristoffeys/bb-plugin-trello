import { test } from 'vitest';
import { createTrelloApi } from '../trello/index.js';

// Opt-in: this suite talks to a real Trello account. Run it with
//   TRELLO_API_KEY=... TRELLO_API_TOKEN=... \
//   TRELLO_LIVE_TEST=1 NODE_USE_ENV_PROXY=1 npx vitest run test/live-probe.test.ts
// Node's fetch ignores the proxy env vars without NODE_USE_ENV_PROXY=1.
const live = process.env.TRELLO_LIVE_TEST === '1';

function credentials() {
  return {
    apiKey: process.env.TRELLO_API_KEY ?? '',
    apiToken: process.env.TRELLO_API_TOKEN ?? ''
  };
}

test.skipIf(!live)('live read-only probe', { timeout: 120_000 }, async () => {
  const api = createTrelloApi(credentials());

  const viewer = await api.getViewer();
  console.log('viewer:', viewer?.id, viewer?.name);

  const boards = await api.listBoards({ limit: 10 });
  console.log('boards:', boards.map(board => `${board.id} ${board.name}`));
  const probe = boards[0];
  if (!probe) {
    console.log('this token can see no open boards; nothing to probe');
    return;
  }
  console.log('probe board:', probe.id, probe.name, probe.url);

  const lists = await api.listLists(probe.id);
  console.log(
    'lists (pos order):',
    lists.map(list => `${list.id}:${list.name}:${list.stateCategory}`)
  );

  const members = await api.listBoardMembers(probe.id);
  console.log('board members:', members.map(member => `${member.id}:${member.name}`));

  const { cards, matchedCount } = await api.listCards({
    boardId: probe.id,
    status: 'open',
    limit: 3
  });
  console.log('cards on board:', matchedCount);
  console.log('cards:', cards.length);
  for (const card of cards) {
    console.log(
      `  ${card.key} | ${card.status.name}(${card.stateCategory}) | ` +
        `${card.assignee?.name ?? 'unassigned'} | members=${card.memberIds.length} | ` +
        `labels=${JSON.stringify(card.labels)} | due=${card.dueDate ?? '-'}`
    );
    console.log(`    url: ${card.url}`);
    console.log(`    desc: ${JSON.stringify((card.description || '').slice(0, 70))}`);
  }
  if (cards[0]) {
    const one = await api.getCard(cards[0].id);
    console.log('getCard roundtrip:', one?.id === cards[0].id, 'key:', one?.key);
    const comments = await api.getCardComments(cards[0].id);
    console.log(
      'comments:',
      comments.length,
      comments[0] ? `${comments[0].user?.name}: ${comments[0].body.slice(0, 60)}` : ''
    );
    const attachments = await api.listCardAttachments(cards[0].id);
    console.log(
      'card attachments:',
      attachments.map(a => `${a.name}(${a.contentType || '?'}) ${a.isImage ? 'image' : 'file'} ${a.size}b`)
    );
  }
});
