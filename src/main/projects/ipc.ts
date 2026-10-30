import { ipcMain } from 'electron';
import { z } from 'zod';
import { checkWorkspaceSender } from '../ipc';
import { getProjectsState, prepareProjectAction, saveProjectProfile } from './index';
import { reviewProjectGit, syncProjectGit } from './git';

export function registerProjectsIpc() {
  ipcMain.handle('projects:get-state', (event) => {
    checkWorkspaceSender(event);
    return getProjectsState();
  });
  ipcMain.handle('projects:save', (event, input: unknown) => {
    checkWorkspaceSender(event);
    return saveProjectProfile(input);
  });
  ipcMain.handle(
    'projects:prepare-action',
    (event, id: unknown, action: unknown, taskId: unknown) => {
      checkWorkspaceSender(event);
      return prepareProjectAction(
        z.string().uuid().parse(id),
        z.enum(['continue', 'organize', 'review', 'summary']).parse(action),
        z.string().optional().parse(taskId),
      );
    },
  );
  ipcMain.handle('projects:git-review', (event, id: unknown) => {
    checkWorkspaceSender(event);
    return reviewProjectGit(z.string().uuid().parse(id));
  });
  ipcMain.handle('projects:sync', (event, input: unknown) => {
    checkWorkspaceSender(event);
    return syncProjectGit(input);
  });
}
