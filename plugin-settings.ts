import type { PluginSettingDescriptors } from '@get-bb/plugin-sdk';

/**
 * Install-wide preferences. Keep these separate from project-board settings:
 * changing a composer affordance must not rewrite a project's Trello mapping
 * or its board-view preferences.
 */
export const trelloPluginSettings = {
  composerCardActionEnabled: {
    type: 'boolean',
    label: 'Show “Turn prompt into Trello card” in the chat composer',
    description:
      'Adds the Trello card action to thread and new-thread chat composers.',
    default: true
  }
} satisfies PluginSettingDescriptors;
