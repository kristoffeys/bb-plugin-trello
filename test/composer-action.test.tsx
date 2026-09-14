// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';

async function composerAction() {
  const app = await loadPluginApp(() => import('../app.js'));
  const customization = app.composerCustomizations.find(
    entry => entry.id === 'create-trello-card'
  );
  const action = customization?.actions?.find(entry => entry.id === 'create-task');
  if (!action) throw new Error('Trello composer action was not registered');
  return action;
}

describe('Trello composer action visibility', () => {
  it('renders by default for backward compatibility', async () => {
    const action = await composerAction();
    const slot = renderSlot(action, {}, {
      composer: { text: 'Create a card from this prompt' }
    });

    expect(slot.getByLabelText('Create Trello card')).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it('is absent when the persisted preference is disabled', async () => {
    const action = await composerAction();
    const slot = renderSlot(action, {}, {
      settings: { composerCardActionEnabled: false },
      composer: { text: 'Create a card from this prompt' }
    });

    expect(slot.queryByLabelText('Create Trello card')).toBeNull();
    slot.lifecycle.unmount();
  });
});
