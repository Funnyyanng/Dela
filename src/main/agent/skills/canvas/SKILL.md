---
name: canvas
description: Canvas 课程平台：课程与资料检索、作业要求阅读、把课件与资料关联进项目
---

# Canvas 课程资料

课程文件、实验要求、公告等教学资料在 Canvas。查资料、读课件时用本 Skill。

## 命令（Bash 内 dela）

- `dela get_canvas_status '{}'`：连接状态
- `dela list_canvas_courses '{}'`：已缓存课程列表
- `dela search_canvas_sources '{"query":"实验"}'`：按标题搜课程资料
- `dela refresh_canvas_courses` / `dela refresh_canvas_course`：同步课程（先同步后搜索）
- `dela read_resource '{"ref":{"type":"canvas","id":"file:123"}}'`：读资料页面正文；文件正文使用 document-reading Skill
- `dela link_canvas_source`：把资料作为来源引用加入项目
- `dela copy_file_to_project`：把资料复制为项目文件，长期使用
- `dela get_local_canvas_status '{}'`：查看已关联的本地课程目录、课程映射与同步概况，不联网
- `dela sync_local_canvas '{"courseId":123,"assignmentIds":[456]}'`：只增量更新指定作业的原题与附件；仅传 courseId 更新这门课程，无参数才更新全部已关联课程。只处理本次任务所需范围。
- `dela refresh_todos '{"courseId":123}'`：核对本课程最新提交状态；无参数刷新所有有效选课，不提交作业。

## 指引

- 只匹配缓存标题；先确认状态已连接、课程已同步
- 已关联本地课程时先用原目录资料。笔记保存到对应课程的“学习笔记”，作业成果保存到对应作业或大作业目录，保留题目和附件。不要每次写笔记都重新下载或全量刷新课程。
- 本地课程同步的文件冲突和失败必须明确报告；新旧版本并存时先确定使用哪个版本。作业说明与题目附件和“我的提交”是不同来源。
- 实验报告、大作业的要求文档读完后，把要点整理进项目笔记，课件用 link 或 copy 挂进项目
- 作业截止时间见 TODO（query_assignments），统一日程会直接显示截止点，不要另外创建事件或修改原作业 DDL。只有用户安排的固定活动才用 create_event 写入日历
- 通用：`dela help` 查看全部命令与参数；不确定就先 help，不要猜测
