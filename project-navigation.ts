import type { TrackerProject } from './contract.js';

/** Projects eligible for the regular board navigation. */
export function linkedProjects(
  projects: readonly TrackerProject[] | undefined
): readonly TrackerProject[] | undefined {
  return projects?.filter(project => project.boardId !== '');
}

/** A Manage route may name any BB project, including one not linked yet. */
export function manageProjectId(
  requestedProjectId: string | null,
  projects: readonly TrackerProject[] | undefined
): string | null {
  if (requestedProjectId && projects?.some(project => project.id === requestedProjectId)) {
    return requestedProjectId;
  }
  return projects?.[0]?.id ?? null;
}
