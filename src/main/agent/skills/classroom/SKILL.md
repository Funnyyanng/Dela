---
name: classroom
description: 交大课堂录像：查询课程节次，先建立紧凑时间索引，再按时间范围分段读取语音识别文稿，批量保存完整文稿
---

# 课堂语音文稿

复用 Dela 的校园登录。登录失效时请用户在课堂视频页面登录，不索取 Cookie、JWT 或 cURL。

## 命令（Bash 内 dela）

- `dela list_classroom_courses '{"query":"课程关键词"}'`：查本学期课程，支持 offset/limit 分页。
- `dela list_classroom_videos '{"courseId":123}'`：查课程录像节次，同样支持分页。
- `dela outline_classroom_transcript '{"videoId":456}'`：先建立本地讲稿索引，默认每十分钟一组，返回时间范围、短预览、标题/词频关键词候选及字符数；不返回全文。可用 `groupMinutes` 调整分组，`offset`/`limit` 翻页，默认 12 组、最多 30 组。
- `dela read_classroom_transcript '{"videoId":456,"startSeconds":600,"endSeconds":900}'`：读取 10–15 分钟的文稿，不写文件，不要求工作区。
- `dela download_classroom_transcripts '{"courseId":123,"videoIds":[456,457],"directory":"/本机绝对路径"}'`：逐节保存完整 TXT。Windows 目录使用 `C:/...`。

## 指引

- 先查询真实课程和录像 ID，不猜测编号；录像 ID 不等于教学班 ID。
- 整理长篇讲稿或结合 PPT 写笔记时，先调用 `outline_classroom_transcript` 读取紧凑时间索引，并与课件的本地目录/关键词索引对应，确定章节与时间范围；不要先连续读取整节课或遍历所有课程搜索内容。标题和词频候选只供定位，不是语义总结，也不代表教师明确的重点。索引 `nextOffset` 非空时继续翻页，保证用户要求的目标范围没有漏组；每段按起始时间归组，跨组的完整段落在后续按时间阅读时可能重叠，核对时避免重复笔记。
- 对多章节笔记使用 `run_task_step`：主会话保留整体计划、紧凑索引、章节重点与进度；`task` 只传录像 ID、真实时间范围、相关课件路径/页段、学习笔记 Skill、目标深度和约束，不粘贴全文。临时步骤按范围调用 `read_classroom_transcript`，读懂后先把完整详细笔记写到 `outputPath`，仅回传重点、覆盖范围、待核对点和文件位置，随后释放该步上下文，再进行下一章。子步骤内直接完成范围，不再次分派步骤。不能用简短回传替代详细推导、例题或用户要求的覆盖范围；单文件要求最终在本地合并章节文件，不把全文重新灌入主会话。
- 读取默认只取前五分钟，返回与时间区间重叠的完整段落。单次默认 6000 字符、最多 12000 字符；有 nextOffset 时保持原时间范围并续读，读完后按需使用 nextStartSeconds 进入后续区间。不要连续拉完整学期充满上下文。
- available=false 表示暂无文稿；available=true 而 text 为空表示该区间无匹配内容。网络或登录错误不等于暂无文稿。识别文本可能有误，引用时注明课程、节次和时间。
- 只有用户要求保存时才下载。目标是本机目录，必须来自用户明确指定的位置或已经明确的本地项目，不根据界面当前选中项猜测。无工作区时优先只读，需要下载先明确目录；远程项目不要把远端路径传给本机下载命令。
- 下载不截取时间范围，每项返回 saved/unavailable/failed。已有文件不会覆盖；只针对需要的节次重试。
- `dela help '{"command":"read_classroom_transcript"}'` 查看参数，不确定时先查 help。
