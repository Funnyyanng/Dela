import { z } from 'zod';
import { realpathSync } from 'node:fs';
import { workspacePathAffected } from '../../../../shared/workspace';
import { exportSavedMarkdownPdf } from '../../../documents/markdown-pdf';
import {
  getLearningCourses,
  getLearningOverview,
  inspectLearningFiles,
  inspectLearningFilesSchema,
  practiceAttemptSchema,
  queryLearningRecords,
  refreshLearningSources,
  registerLocalLearningSource,
  registerLocalLearningSourceSchema,
  saveLearningNote,
  saveLearningNoteSchema,
  saveLearningPractice,
  saveLearningPracticeSchema,
  saveLearningTask,
  saveLearningTaskSchema,
  submitLearningPracticeAttempt,
} from '../../../learning';
import { limit, match, offset, page, query, tool, type AgentTool } from '../shared';
import { noteRevisionTools } from './note-revisions';

const courseId = z.number().int().positive();

export const learningTools = {
  export_learning_pdf: tool(
    '将课程中已保存的 Markdown 原稿导出为同目录的 A4 PDF，无需保存弹窗。保留公式和图表，不覆盖已有 PDF；需修订时指定新的 outputName。导出成功后仍须检查实际渲染页，不能把导出当成排版复核。',
    z
      .object({ courseId, path: z.string().min(1), outputName: z.string().min(1).optional() })
      .strict(),
    async ({ courseId, path, outputName }) => {
      const course = getLearningCourses().find((item) => item.id === courseId);
      if (!course || !workspacePathAffected(realpathSync(path), realpathSync(course.directory)))
        throw new Error('请选择本课程目录中的原稿');
      return { path: await exportSavedMarkdownPdf(path, outputName), layoutChecked: false };
    },
  ),
  get_learning_state: tool(
    '读取本地课程学习概况、课程目录和中间审阅工作目录。只返回记录数和告警；详细资料与学习记录分别用 query_learning_sources/query_learning_records 分页查询。已核对状态表示成果通过已登记要求的检查，不代表提交或掌握。',
    z.object({ courseId: courseId.optional() }).strict(),
    async ({ courseId }) => {
      await refreshLearningSources(courseId);
      return getLearningOverview(courseId);
    },
  ),
  query_learning_sources: tool(
    '分页列出课程资料的来源、证据说明、本地路径、版本和实际冲突，不读取正文。包括 Canvas、微信及本地参考资料；origin 表示取得渠道，不代表内容正确性。先按标题筛选，再只读取当前任务需要的页段。',
    z.object({ courseId, query, offset, limit }).strict(),
    async ({ courseId, query, offset, limit }) => {
      await refreshLearningSources(courseId);
      const course = getLearningCourses().find((item) => item.id === courseId);
      return page(
        (course?.sources ?? []).filter((item) =>
          match(`${item.title} ${item.localPath ?? ''}`, query),
        ),
        offset,
        limit,
      );
    },
  ),
  query_learning_records: tool(
    '分页查询任务、规范笔记或复习题。列表只返回概况；提供 id 返回一条完整记录。练习的参考答案仅在提供 id 时返回，只有用户实际作答才登记尝试。',
    z
      .object({
        kind: z.enum(['tasks', 'notes', 'practice']),
        courseId: courseId.optional(),
        id: z.string().uuid().optional(),
        query,
        offset,
        limit,
      })
      .strict(),
    ({ kind, courseId, id, query, offset, limit }) => {
      const records = queryLearningRecords(kind, courseId).filter(
        (item) => (!id || item.id === id) && match(JSON.stringify(item), query),
      );
      const items = id
        ? records
        : records.map((item) => {
            if ('requirements' in item)
              return {
                id: item.id,
                courseId: item.courseId,
                title: item.title,
                status: item.status,
                dueAt: item.dueAt,
                requirements: item.requirements.length,
                openFindings: item.findings.filter((finding) => finding.status === 'open').length,
                warnings: item.warnings,
              };
            if ('coveredSources' in item)
              return {
                id: item.id,
                courseId: item.courseId,
                title: item.title,
                path: item.path,
                coveredSources: item.coveredSources.length,
                warnings: item.warnings,
              };
            return {
              id: item.id,
              courseId: item.courseId,
              prompt: item.prompt,
              dueAt: item.dueAt,
              attempts: item.attempts.length,
              lastErrorCause: item.attempts.at(-1)?.errorCause ?? '',
            };
          });
      return page<unknown>(items, offset, limit);
    },
  ),
  inspect_learning_files: tool(
    '核对指定课程内成果或证据文件的 SHA-256 版本，用于保存任务记录；仅处理指定文件，不扫描课程正文。',
    inspectLearningFilesSchema,
    inspectLearningFiles,
  ),
  register_learning_source: tool(
    '登记课程内已有的微信附件、Canvas 本地归档或其他参考资料，记录取得渠道和证据说明；不移动或修改原件。只有用户明确指认或下载记录等真实证据支持时才标为 wechat/canvas，不能凭文件名推断；未知渠道用 local。该标签不代表作者、内容正确性或已联网确认最新版本。不能登记学习笔记或已记录的作业成果作为原始资料。',
    registerLocalLearningSourceSchema,
    registerLocalLearningSource,
  ),
  save_learning_task: tool(
    '创建或完整更新本地学习任务。逐条登记要求、成果与证据的关联和审阅问题。draft 可包含待完成项；checked 需要全部要求已满足、全部问题关闭、成果证据存在且 SHA-256 匹配，证据 description 给出页码/行号/验证结果。有 assignmentSourceId 时，checked 必须提供实际审阅的 assignmentSourceVersion（来自 query_learning_sources），或沿用同一来源已有草稿记录的版本；版本须与当前来源一致。checks 须明确复核 requirements、sources、calculations 三类，计算不适用须说明。不提交 Canvas 作业。',
    saveLearningTaskSchema,
    saveLearningTask,
  ),
  save_learning_note: tool(
    '登记已有规范笔记及其已覆盖来源版本；不写入笔记正文、不增加掌握程度。路径须在课程“学习笔记”内；更新笔记使用受保护笔记命令，再重新核对覆盖来源。',
    saveLearningNoteSchema,
    saveLearningNote,
  ),
  save_learning_practice: tool(
    '创建或更新有来源的复习题和参考答案。新题立即到期，生成题目或笔记不会登记尝试或掌握；修改题面/答案重置复习间隔，保留实际尝试记录。',
    saveLearningPracticeSchema,
    saveLearningPractice,
  ),
  submit_learning_practice_attempt: tool(
    '记录用户实际给出的答案、本人反馈 again/hard/good 和错误原因，安排下次复习。禁止把 Agent 生成的答案作为用户尝试；该反馈不等于客观正确性或掌握认定。',
    practiceAttemptSchema,
    submitLearningPracticeAttempt,
  ),
  ...noteRevisionTools,
} satisfies Record<string, AgentTool>;
