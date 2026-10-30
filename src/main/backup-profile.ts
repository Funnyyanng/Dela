import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

const selectionSchema = z.object({ current: z.string(), previous: z.string().nullable() });
const selectionPath = () => join(app.getPath('appData'), 'Dela-profile-selection.json');

function readSelection() {
  try {
    return selectionSchema.parse(JSON.parse(readFileSync(selectionPath(), 'utf8')));
  } catch {
    return null;
  }
}

export function initializeUserDataProfile() {
  const selection = readSelection();
  if (
    selection &&
    isAbsolute(selection.current) &&
    existsSync(join(selection.current, 'dela.db'))
  ) {
    app.setPath('userData', selection.current);
  }
}

export function previousUserDataProfile(): string | null {
  return readSelection()?.previous ?? null;
}

export function activateUserDataProfile(path: string) {
  if (!isAbsolute(path) || !existsSync(join(path, 'dela.db'))) {
    throw new Error('所选数据目录不可用，请重新检查备份');
  }
  const temporary = `${selectionPath()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ current: path, previous: app.getPath('userData') }), {
    mode: 0o600,
  });
  renameSync(temporary, selectionPath());
  app.relaunch();
  app.quit();
}
