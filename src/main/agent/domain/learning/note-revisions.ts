import { tool } from '../shared';
import {
  inspectLearningNote,
  updateLearningNote,
  restoreLearningNote,
  learningNoteTarget,
  learningNoteUpdate,
  learningNoteRestore,
} from '../../../learning/note-revisions';

export const noteRevisionTools = {
  inspect_learning_note: tool(
    '取得课程笔记当前版本和最近20次修改前版本，不读取全文；更新前先 read 原笔记及用户批注。',
    learningNoteTarget,
    inspectLearningNote,
  ),
  update_learning_note: tool(
    '按当前版本精确替换唯一段落，保留其他原文与修改前快照；版本冲突或段落歧义时不修改。新文件用 createText，已有文件只用 edits。不得覆盖用户批注。',
    learningNoteUpdate,
    updateLearningNote,
  ),
  restore_learning_note: tool(
    '将课程笔记恢复到已记录的历史版本；先核对当前 revision，恢复前再保存快照，避免覆盖期间的新修改。',
    learningNoteRestore,
    restoreLearningNote,
  ),
};
