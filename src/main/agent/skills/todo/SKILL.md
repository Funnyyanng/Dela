---
name: todo
description: 待办与 Canvas 作业：查询、创建、完成个人待办，跟踪作业提交状态与截止时间
---

# 待办与作业

个人待办与 Canvas 作业统一在 TODO 列表。

## 命令（Bash 内 dela）

- `dela query_todos '{}'`：个人待办（含已完成开关）
- `dela query_assignments '{}'`：Canvas 作业与提交状态（按课程过滤）
- `dela save_todo`：创建/更新待办（标题、备注、截止时间）
- `dela remove_todo`：删除个人待办
- `dela refresh_todos '{}'`：手动同步作业

## 指引

- Canvas 作业只读：区分未完成、已提交、已批改、豁免、需重交；提交要在 Canvas 完成
- 优先查询本地缓存；需要最新状态时刷新一次，再按课程、截止时间和完成状态筛选。列表按 `offset/limit` 分页，只读相关页
- 保存只返回完整目标 `item`，删除只返回确认，刷新只返回统计与同步状态；这些结果不再附带整份清单，需要条目时调用分页查询
- 作业列表不含描述；说明正文通过 `search_canvas_sources`（`kind=assignment`）找到引用后，用 `read_resource` 分页读取，HTML 保留原始链接
- 需要提交限制与评分量表时，用 `query_assignments` 的 `assignmentId` 定位单份作业并设 `includeRequirements=true`；`assignmentRequirements` 保留 Canvas 已提供的格式、次数、分值和 rubric，`null` 表示未提供或尚未同步，不能据此编造评分标准。默认列表省略这些详细字段
- 截止时间临近需要提醒时，用 curriculum 的 create_event 写入日历
- 通用：`dela help` 查看全部命令与参数；不确定就先 help，不要猜测
