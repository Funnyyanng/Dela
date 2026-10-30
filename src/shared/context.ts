export interface ContextNote {
  id: string;
  scope: 'personal' | 'course' | 'project';
  scopeId: string;
  title: string;
  content: string;
  updatedAt: string;
}

export interface ContextApi {
  list(): Promise<ContextNote[]>;
  save(input: Omit<ContextNote, 'id' | 'updatedAt'> & { id?: string }): Promise<ContextNote[]>;
  remove(id: string): Promise<ContextNote[]>;
}
