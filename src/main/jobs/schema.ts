import { z } from 'zod';

export const progressSchema = z
  .object({
    jobId: z.string().uuid(),
    stage: z.string().trim().min(1).max(100),
    summary: z.string().max(2000).optional(),
    question: z.string().trim().min(1).max(2000).optional(),
    files: z
      .array(
        z
          .object({ path: z.string().min(1).max(32767), title: z.string().min(1).max(300) })
          .strict(),
      )
      .max(30)
      .optional(),
  })
  .strict();
