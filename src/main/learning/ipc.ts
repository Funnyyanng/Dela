import { ipcMain } from 'electron';
import { checkWorkspaceSender } from '../ipc';
import { getLearningState, submitLearningPracticeAttempt } from './index';

export function registerLearningIpc() {
  ipcMain.handle('learning:get-state', (event) => {
    checkWorkspaceSender(event);
    return getLearningState();
  });
  ipcMain.handle('learning:submit-practice-attempt', (event, input: unknown) => {
    checkWorkspaceSender(event);
    submitLearningPracticeAttempt(input);
    return getLearningState();
  });
}
