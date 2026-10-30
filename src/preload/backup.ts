import type { BackupApi } from '../shared/backup';
import { invoke } from './lib';

export const backup: BackupApi = {
  exportData: (options) => (options ? invoke('backup:export', options) : invoke('backup:export')),
  getCoverage: () => invoke('backup:coverage'),
  inspect: () => invoke('backup:inspect'),
  restore: (path, manifestHash) => invoke('backup:restore', path, manifestHash),
  activate: (profilePath) => invoke('backup:activate', profilePath),
  returnToPrevious: () => invoke('backup:return-to-previous'),
};
