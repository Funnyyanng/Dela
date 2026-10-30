import type { ContextApi } from '../shared/context';
import { invoke } from './lib';
export const context: ContextApi = {
  list: () => invoke('context:list'),
  save: (input) => invoke('context:save', input),
  remove: (id) => invoke('context:remove', id),
};
