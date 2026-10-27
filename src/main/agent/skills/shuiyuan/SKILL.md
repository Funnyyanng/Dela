---
name: shuiyuan
description: 上海交大水源社区（BBS）：搜索与浏览话题、读帖子正文、把帖子关联进项目
---

# 水源社区

水源是交大校园论坛。搜索讨论、查看帖子时用本 Skill。

## 命令（Bash 内 dela）

- `dela shuiyuan_status '{}'`：连接与登录状态
- `dela search_shuiyuan_topics '{"query":"关键词"}'`：搜索话题
- `dela list_shuiyuan_topics`：按分类/最新浏览话题（支持分页）
- `dela list_shuiyuan_categories '{}'`：分类与站点结构
- `dela read_shuiyuan_topic` / `dela read_shuiyuan_posts`：话题正文与楼层
- `dela link_shuiyuan_topic`：把话题作为来源引用加入项目

## 指引

- 帖子正文返回 HTML，引用与图片链接保留原始标记
- 正文每次默认最多 6000 字符（`limit` 最大 12000），只读解决当前问题所需的楼层。长楼 HTML 可能分片；同一楼按返回的 `offset/nextOffset` 顺序拼接可恢复原文
- `read_shuiyuan_topic` 的 `stream` 最多 50 个 id，`streamTotal` 是总数；`postOffset` 是完整 id 流中的位置，`nextStreamOffset` 可用于定位下一组 id，不能把当前 stream 当作全帖
- 继续全文优先把非空 `nextCursor` 原样作为同一命令的参数：主题命令按 `postOffset/offset` 续读，楼层命令按剩余 `postIds/offset` 续读，直到 `nextCursor=null`。缺失楼层会单列 `missingPostIds`，不要当作已获取正文
- 游标中的 `snapshotId` 复用本次读取的短时快照，避免每个正文片段重新联网；普通首次读取仍联网，`freshness.kind` 标明该页是否来自缓存。快照最多保留一个主题、5 分钟、100 楼正文和 4 MiB；过期、被新读取替换或账号切换时会明确报错，需要重新读取。超过缓存大小的正文仍支持续读，但可能重新联网
- 主题和楼层命令的首次联网失败会直接报错；`read_resource` 读取已关联来源时可能回退本地缓存摘要，带 `degraded` 标注，需说明内容不完整
- 讨论结论值得沉淀时，用 link_shuiyuan_topic 关联进项目，或把要点写进项目笔记
- 通用：`dela help` 查看全部命令与参数；不确定就先 help，不要猜测
