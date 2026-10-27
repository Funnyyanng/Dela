import { stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  formatSegments,
  formatTranscript,
  getTranscript,
  listCourses,
  listVideos,
} from '../../../vsjtu/api';
import { safeFileName } from '../../../vsjtu/transcript';
import { limit, match, offset, page, query, tool } from '../shared';

const id = z.number().int().positive();

export const classroomTools = {
  list_classroom_courses: tool(
    '联网列出本学期课堂视频课程，返回教学班 ID。需要先在课堂视频页面登录。',
    z.object({ query, offset, limit }).strict(),
    async ({ query, offset, limit }) =>
      page(
        (await listCourses()).filter((course) => match(`${course.name} ${course.code}`, query)),
        offset,
        limit,
      ),
  ),
  list_classroom_videos: tool(
    '联网列出指定教学班的录像节次；返回的录像 id 用于读取或下载语音文稿。',
    z.object({ courseId: id, offset, limit }).strict(),
    async ({ courseId, offset, limit }) => page(await listVideos(courseId), offset, limit),
  ),
  outline_classroom_transcript: tool(
    '先在本地为课堂语音文稿建立紧凑时间索引，默认每十分钟一组，仅返回时间范围、短预览、标题和词频关键词候选及字符数，不返回全文。候选是本地标题/词频索引，不是语义总结或教师确认的重点；按返回时间范围继续读取。',
    z
      .object({
        videoId: id,
        groupMinutes: z.number().int().min(1).max(60).default(10),
        offset,
        limit: z.number().int().min(1).max(30).default(12),
      })
      .strict(),
    async ({ videoId, groupMinutes, offset, limit }) => {
      const transcript = await getTranscript(videoId);
      const interval = groupMinutes * 60 * 1000;
      const groups = new Map<number, NonNullable<typeof transcript>['segments']>();
      for (const segment of transcript?.segments ?? []) {
        const start = Math.floor(segment.startMs / interval) * interval;
        const group = groups.get(start) ?? [];
        group.push(segment);
        groups.set(start, group);
      }
      const ranges = [...groups.keys()].sort((a, b) => a - b);
      const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
      const stopWords = new Set(
        '我们 你们 他们 这个 那个 一个 就是 然后 所以 因为 如果 但是 可以 需要 进行 这里 这些 一些 时候 现在 the and for with from this that have will into are not can'.split(
          ' ',
        ),
      );
      const items = ranges.slice(offset, offset + limit).map((startMs) => {
        const segments = groups.get(startMs)!;
        const text = segments.map((segment) => segment.text).join('\n');
        const counts = new Map<string, number>();
        for (const part of segmenter.segment(text)) {
          const word = part.segment.toLocaleLowerCase();
          if (
            part.isWordLike &&
            word.length >= 2 &&
            word.length <= 24 &&
            /\p{L}/u.test(word) &&
            !stopWords.has(word)
          )
            counts.set(word, (counts.get(word) ?? 0) + 1);
        }
        return {
          startSeconds: startMs / 1000,
          endSeconds:
            segments.reduce((end, segment) => Math.max(end, segment.endMs), startMs + interval) /
            1000,
          titleCandidate: segments[0]!.text
            .trim()
            .split(/[。！？!?\n]/u, 1)[0]!
            .slice(0, 48),
          keywordCandidates: [...counts]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([word]) => word),
          preview: text.slice(0, 96),
          totalCharacters: segments.reduce((sum, segment) => sum + segment.text.length, 0),
        };
      });
      return {
        videoId,
        available: transcript !== null,
        method: 'local_title_and_token_frequency',
        note: '标题和词频候选仅供定位，不代表语义总结或教师确认的重点。原文、公式和例子需要按时间范围读取核对。',
        groupMinutes,
        totalCharacters:
          transcript?.segments.reduce((sum, segment) => sum + segment.text.length, 0) ?? 0,
        items,
        total: ranges.length,
        nextOffset: offset + limit < ranges.length ? offset + limit : null,
      };
    },
  ),
  read_classroom_transcript: tool(
    '读取录像时间范围内的语音文稿，不写文件、不要求工作区。时间单位为秒，默认读取前五分钟；包含与区间重叠的完整段落，正文按字符分页，nextOffset 用于同一区间续读。',
    z
      .object({
        videoId: id,
        startSeconds: z.number().nonnegative().default(0),
        endSeconds: z.number().positive().optional(),
        offset,
        limit: z.number().int().min(1).max(12000).default(6000),
      })
      .strict(),
    async ({ videoId, startSeconds, endSeconds = startSeconds + 300, offset, limit }) => {
      if (endSeconds <= startSeconds) throw new Error('结束时间必须晚于开始时间');
      const transcript = await getTranscript(videoId);
      const segments =
        transcript?.segments.filter(
          (segment) => segment.endMs > startSeconds * 1000 && segment.startMs < endSeconds * 1000,
        ) ?? [];
      const text = segments.length ? formatSegments(segments) : '';
      return {
        videoId,
        available: transcript !== null,
        startSeconds,
        endSeconds,
        text: text.slice(offset, offset + limit),
        totalCharacters: text.length,
        nextOffset: offset + limit < text.length ? offset + limit : null,
        nextStartSeconds: transcript?.segments.some((segment) => segment.endMs > endSeconds * 1000)
          ? endSeconds
          : null,
      };
    },
  ),
  download_classroom_transcripts: tool(
    '将同一课程中选定节次的完整文稿逐节保存为 TXT，返回各项结果，不返回正文。必须明确指定本机绝对目录；已有文件不覆盖。不支持远端目录。',
    z
      .object({ courseId: id, videoIds: z.array(id).min(1).max(100), directory: z.string().min(1) })
      .strict(),
    async ({ courseId, videoIds, directory }) => {
      if (!isAbsolute(directory)) throw new Error('请指定本机文件夹的绝对路径');
      if (!(await stat(directory)).isDirectory()) throw new Error('保存位置不是文件夹');
      const course = (await listCourses()).find((course) => course.id === courseId);
      if (!course) throw new Error('未找到指定课程，请先列出课堂视频课程');
      const videos = await listVideos(courseId);
      const selected = [...new Set(videoIds)].map((id) => {
        const video = videos.find((video) => video.id === id);
        if (!video) throw new Error(`录像 ${id} 不在指定课程中`);
        return video;
      });
      const results: Array<{
        videoId: number;
        status: 'saved' | 'unavailable' | 'failed';
        path?: string;
        error?: string;
      }> = [];
      for (const video of selected) {
        try {
          const transcript = await getTranscript(video.id);
          if (!transcript) {
            results.push({ videoId: video.id, status: 'unavailable' });
            continue;
          }
          const title = `${course.name} · ${video.start} · 第 ${video.period || '?'} 节`;
          const name = safeFileName(`${course.name}-${video.start}`);
          const path = join(directory, `${name}-${video.id}.txt`);
          await writeFile(path, formatTranscript(transcript, title), {
            encoding: 'utf8',
            flag: 'wx',
          });
          results.push({ videoId: video.id, status: 'saved', path });
        } catch (error) {
          results.push({
            videoId: video.id,
            status: 'failed',
            error: error instanceof Error ? error.message : '文稿保存失败',
          });
        }
      }
      return { courseId, results };
    },
  ),
};
