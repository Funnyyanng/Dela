import { reportJobProgress } from '../../../jobs';
import { progressSchema } from '../../../jobs/schema';
import { tool } from '../shared';
export const jobsTools = {
  report_job_progress: tool(
    '记录当前任务中心任务的阶段与实际成果。需要用户补充时设置 question，并结束本轮等待；不得代填用户答案。files 只能登记当前项目中实际存在的文件。不会修改作业复核或提交状态。',
    progressSchema,
    reportJobProgress,
  ),
};
