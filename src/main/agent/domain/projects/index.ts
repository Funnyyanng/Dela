import { z } from 'zod';
import {
  addProjectReference,
  getProjectProfile,
  getProjectsState,
  projectSaveSchema,
  saveProjectProfile,
} from '../../../projects';
import { getTodoState } from '../../../todo';
import { tool } from '../shared';

export const projectTools = {
  query_project_workspace: tool(
    '读取项目目标、成功标准、里程碑、资料与实际待办。省略 projectId 返回项目摘要，不读取文件正文。',
    z.object({ projectId: z.string().uuid().optional() }).strict(),
    ({ projectId }) =>
      projectId
        ? {
            project: getProjectProfile(projectId),
            tasks: getTodoState().items.filter((item) => item.projectId === projectId),
          }
        : getProjectsState().projects.map(({ projectId, name, type, goal, stage, nextStep }) => ({
            projectId,
            name,
            type,
            goal,
            stage,
            nextStep,
          })),
  ),
  save_project_profile: tool(
    '保存用户明确要求的项目目标、里程碑及约定。先 query_project_workspace，expectedUpdatedAt 必须传当前 project.updatedAt（首次为 null）；冲突时重新查询并合并明确变更，保留其他更新。生成计划不能标记实际完成。不会移动文件或推送 Git。',
    projectSaveSchema,
    saveProjectProfile,
  ),
  register_project_artifact: tool(
    '登记本项目的资料或成果路径，不创建或移动文件；成果登记不代表复核通过。',
    z
      .object({
        projectId: z.string().uuid(),
        title: z.string().min(1).max(1000),
        path: z.string().min(1).max(32767),
        kind: z.enum(['source', 'deliverable']),
      })
      .strict(),
    ({ projectId, title, path, kind }) => addProjectReference(projectId, title, path, kind),
  ),
};
