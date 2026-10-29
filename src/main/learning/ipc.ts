import { ipcMain } from 'electron';
import { checkWorkspaceSender } from '../ipc';
import { getLearningState, refreshLearningSources, submitLearningPracticeAttempt } from './index';

export function registerLearningIpc() {
  ipcMain.handle('learning:get-state', async (event) => {
    checkWorkspaceSender(event);
    await refreshLearningSources();
    return getLearningState();
  });
  ipcMain.handle('learning:submit-practice-attempt', (event, input: unknown) => {
    checkWorkspaceSender(event);
    submitLearningPracticeAttempt(input);
    return getLearningState();
  });
}
