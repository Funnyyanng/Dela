import { z } from 'zod';
import { getWorkspaceState, remoteProjectOf } from '../../../workspace/api';
import { getLocalWorkspaceState, listLocalDirectory } from '../../../workspace/local-tree';
import { workspaceEntryIdSchema } from '../../../../shared/workspace';
import { limit, match, offset, page, query, tool } from '../shared';

export const listWorkspaceEntriesTool = tool(
  '浏览或按名称弱过滤工作区条目（项目、文件夹、笔记、来源引用、本地文件）。只读。浏览时传 parentId 限定直接子条目，null 表示根目录，避免遍历其他目录；仅全局查找时省略 parentId。query 为空即浏览。返回条目与可经 dela read_resource 命令读取的引用。',
  z
    .object({ query, parentId: workspaceEntryIdSchema.nullable().optional(), offset, limit })
    .strict(),
  async ({ query, parentId, offset, limit }) => {
    const entries =
      parentId === undefined
        ? getWorkspaceState().entries
        : parentId === null
          ? (await getLocalWorkspaceState()).entries.filter((item) => item.parentId === null)
          : remoteProjectOf(parentId)
            ? []
            : await listLocalDirectory(parentId);
    return page(
      entries
        .filter((item) => match(item.name, query))
        .map((item) => ({ ...item, ref: { type: 'workspace', id: item.id } })),
      offset,
      limit,
    );
  },
);
