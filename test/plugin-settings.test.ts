import { describe, expect, it } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.js';
import { trelloPluginSettings } from '../plugin-settings.js';
import type { BbPluginApi, PluginSettingsHandle } from '@get-bb/plugin-sdk';

describe('composer action preference', () => {
  it('is declared as an enabled-by-default plugin setting', async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: 'trello' });

    await plugin(bb);

    expect(harness.inspection.registrations.settingsDescriptors).toMatchObject({
      composerCardActionEnabled: {
        type: 'boolean',
        default: true,
        label: 'Show “Turn prompt into Trello card” in the chat composer'
      }
    });
    await harness.lifecycle.dispose();
  });

  it('persists a disabled value across a plugin reload', async () => {
    let settings: PluginSettingsHandle<typeof trelloPluginSettings>;
    const settingsPlugin = async (bb: BbPluginApi) => {
      settings = bb.settings.define(trelloPluginSettings);
    };
    const { bb, harness } = createFakePluginHost({ pluginId: 'trello' });

    await settingsPlugin(bb);
    expect(await settings!.get()).toEqual({ composerCardActionEnabled: true });

    await harness.behavior.setSettings({ composerCardActionEnabled: false });
    expect(await settings!.get()).toEqual({ composerCardActionEnabled: false });

    await harness.lifecycle.reload(settingsPlugin);
    expect(await settings!.get()).toEqual({ composerCardActionEnabled: false });
    await harness.lifecycle.dispose();
  });
});
