/** 导出本机数据：复制到用户选定的位置，界面不做任何文件操作。 */
export interface BackupApi {
  exportData(options?: { includeExternal?: boolean }): Promise<BackupResult>;
  getCoverage(): Promise<BackupCoverage>;
  inspect(): Promise<BackupInspection | null>;
  restore(path: string, manifestHash: string): Promise<BackupRestoreResult | null>;
  activate(profilePath: string): Promise<void>;
  returnToPrevious(): Promise<void>;
}

export interface BackupCoverage {
  currentProfile: string;
  previousProfile: string | null;
  externalProjects: { name: string; path: string; remote: boolean }[];
}

export interface BackupInspection {
  path: string;
  manifestHash: string;
  createdAt: string;
  fileCount: number;
  bytes: number;
  canRestore: boolean;
  warnings: string[];
  failures: string[];
  sections: { label: string; included: boolean }[];
}

export interface BackupRestoreResult {
  path: string;
  profilePath: string;
  previousSnapshot: string;
  warnings: string[];
}

export type BackupResult =
  /**
   * skipped 是没能复制成功的顶层条目名，原因不止被占用（还可能是权限、磁盘空间、符号链接），
   * 所以只回报名字，让界面说「没复制成功」而不是断言原因。
   */
  | { status: 'exported'; path: string; skipped: string[] }
  | { status: 'cancelled' }
  /** 选定的位置不能用（例如落在 Dela 自己的数据目录里），reason 直接给用户看。 */
  | { status: 'failed'; reason: string };
