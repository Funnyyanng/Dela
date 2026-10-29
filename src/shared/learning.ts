export interface LearningSource {
  sourceId: string;
  title: string;
  kind: string;
  localPath: string | null;
  version: string;
  revision: string;
  origin?: 'canvas' | 'wechat' | 'local';
  provenance?: string;
  notice?: string;
  warning?: string;
}

export interface LearningCourse {
  id: number;
  name: string;
  projectId: string;
  directory: string;
  workingDirectory: string;
  sources: LearningSource[];
}

export interface LearningArtifact {
  id: string;
  path: string;
  revision: string | null;
  description: string;
}

export interface LearningTask {
  id: string;
  courseId: number;
  title: string;
  assignmentSourceId?: string;
  assignmentSourceVersion?: string | null;
  dueAt: string | null;
  status: 'draft' | 'checked';
  requirements: {
    id: string;
    text: string;
    status: 'open' | 'met';
    deliverableIds: string[];
    evidenceIds: string[];
  }[];
  deliverables: LearningArtifact[];
  evidence: LearningArtifact[];
  findings: { id: string; text: string; status: 'open' | 'closed' }[];
  checks: {
    kind: 'requirements' | 'sources' | 'calculations';
    status: 'passed' | 'not_applicable';
    description: string;
  }[];
  updatedAt: string;
  checkedAt: string | null;
  warnings: string[];
}

export interface LearningNote {
  id: string;
  courseId: number;
  title: string;
  path: string;
  revision: string;
  coveredSources: { sourceId: string; version: string }[];
  updatedAt: string;
  warnings: string[];
}

export interface LearningPracticeAttempt {
  id: string;
  response: string;
  outcome: 'again' | 'hard' | 'good';
  errorCause: string;
  createdAt: string;
}

export interface LearningPracticeCard {
  id: string;
  courseId: number;
  prompt: string;
  answer: string;
  sourceIds: string[];
  dueAt: string;
  intervalDays: number;
  successfulAttempts: number;
  attempts: LearningPracticeAttempt[];
  updatedAt: string;
}

export interface PracticeAttemptInput {
  cardId: string;
  expectedUpdatedAt?: string;
  response: string;
  outcome: LearningPracticeAttempt['outcome'];
  errorCause?: string;
}

export interface LearningState {
  root: string | null;
  syncedAt: string | null;
  courses: LearningCourse[];
  tasks: LearningTask[];
  notes: LearningNote[];
  practice: LearningPracticeCard[];
  warnings: string[];
  syncHistory?: {
    syncedAt: string;
    unavailable: string[];
    conflicts: string[];
    failed: string[];
  };
}

export interface LearningApi {
  getState(): Promise<LearningState>;
  submitPracticeAttempt(input: PracticeAttemptInput): Promise<LearningState>;
}
