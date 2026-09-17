// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { describe, expect, it } from 'vitest';
import { linkedProjects, manageProjectId } from '../project-navigation';

const projects = [
  { id: 'linked', name: 'Linked', boardId: 'board-1' },
  { id: 'unmapped', name: 'Unmapped', boardId: '' }
];

describe('linked project navigation', () => {
  it('shows only projects with a non-empty Trello board mapping in navigation', () => {
    expect(linkedProjects(projects)).toEqual([projects[0]]);
  });

  it('keeps unmapped projects available to Manage', () => {
    expect(manageProjectId('unmapped', projects)).toBe('unmapped');
  });

  it('provides a Manage target when no projects are linked', () => {
    expect(linkedProjects([{ id: 'unmapped', name: 'Unmapped', boardId: '' }])).toEqual([]);
    expect(manageProjectId(null, [{ id: 'unmapped', name: 'Unmapped', boardId: '' }])).toBe(
      'unmapped'
    );
  });
});

describe('Trello settings access', () => {
  it('keeps the settings section routed to the Manage view for its project', async () => {
    const app = await loadPluginApp(() => import('../app.js'));
    const section = app.settingsSections.find(entry => entry.id === 'connections');
    if (!section) throw new Error('Trello settings section was not registered');

    const slot = renderSlot(section, {}, { context: { projectId: 'unmapped' } });
    fireEvent.click(slot.getByRole('button', { name: 'Open Trello project settings' }));

    expect(slot.navigateCalls).toEqual([
      { method: 'toPluginPanel', path: 'board', options: { subPath: 'manage/unmapped' } }
    ]);
    slot.lifecycle.unmount();
  });
});
