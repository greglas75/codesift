import { z } from 'zod';

export const publishReadinessIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['blocker', 'warning']),
  message: z.string(),
  source: z.enum(['ai_review', 'flow', 'qa', 'comments', 'quotas', 'collectors']),
});
export type PublishReadinessIssue = z.infer<typeof publishReadinessIssueSchema>;

export const publishReadinessSummarySchema = z.object({
  surveyId: z.string(),
  canPublish: z.boolean(),
  blockers: z.array(publishReadinessIssueSchema),
  warnings: z.array(publishReadinessIssueSchema),
});
export type PublishReadinessSummary = z.infer<typeof publishReadinessSummarySchema>;

export const publishReadinessClient = {
  async getSummary(surveyId: string): Promise<PublishReadinessSummary> {
    const response = await fetch(`/api/moderation/publish-readiness/${surveyId}`);
    if (!response.ok) {
      throw new Error(`Failed to load publish readiness (${response.status})`);
    }
    return publishReadinessSummarySchema.parse(await response.json());
  },
};
