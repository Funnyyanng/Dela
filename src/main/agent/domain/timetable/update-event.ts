import { z } from 'zod';
import { calendarEventColors } from '../../../../shared/timetable';
import { updateCalendarEvent } from '../../../timetable/api';
import { tool } from '../shared';
export const updateEventTool = tool(
  '修改已有个人日程。只修改事件本身，不修改课程或作业截止日期。必须先查询确认事件ID。',
  z
    .object({
      id: z.number().int().positive(),
      title: z.string().trim().min(1).max(120),
      startAt: z.string().datetime(),
      endAt: z.string().datetime(),
      location: z.string().max(120).optional(),
      color: z.enum(calendarEventColors).optional(),
    })
    .strict(),
  ({ id, ...input }) => updateCalendarEvent(id, input),
);
