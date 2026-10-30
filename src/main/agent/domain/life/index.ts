import { z } from 'zod';
import {
  getLifeState,
  logHabit,
  saveSleep,
  saveOccurrence,
  habitLogSchema,
  sleepLogSchema,
  occurrenceSchema,
} from '../../../life';
import { tool } from '../shared';
const actual =
  '仅在用户明确提供实际完成或实测记录时使用；不能把计划、建议、AI生成内容视为用户已经完成，未记录保持未知。';
export const lifeTools = {
  query_life: tool(
    '读取生活习惯、实际记录、睡眠和重复事项的具体实例。未记录表示未知，不得自行补写完成情况。日期按北京时间。默认近七天到未来30天，可指定不超过一年的范围。',
    z.object({ startDate: z.string().optional(), endDate: z.string().optional() }).strict(),
    getLifeState,
  ),
  record_habit: tool(
    `记录用户指定习惯在指定日期的实际值，0与未知不同。同日重记替换该日值。${actual}`,
    habitLogSchema,
    (input) => {
      logHabit(input);
      return { saved: true, ...input };
    },
  ),
  record_sleep: tool(
    `记录或按ID更正用户提供的实际睡眠起止时间（UTC ISO8601）。${actual}`,
    sleepLogSchema,
    saveSleep,
  ),
  record_occurrence: tool(
    `更新重复事项的指定日期这一次。完成状态只作用于该次，不修改整个系列；title/dueAt/remindAt也只修改该次。${actual}`,
    occurrenceSchema,
    (input) => {
      saveOccurrence(input);
      return { saved: true, ...input };
    },
  ),
};
