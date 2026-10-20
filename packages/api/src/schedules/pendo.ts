/**
 * FORK: the Pendo `scheduled_run_completed` event (see FORK.md). Scheduled runs happen with no
 * browser open, so they report from here, once per outcome the run row actually took.
 */
import { logger } from '@librechat/data-schemas';
import type { ISchedule, IScheduleRun } from '@librechat/data-schemas';
import type { ScheduleRunStatus } from 'librechat-data-provider';
import type { PendoTracker } from '../pendo';

export interface ScheduledRunReport {
  /** The occurrence's schedule; null once it has been erased. */
  schedule: Pick<ISchedule, 'id' | 'user' | 'tenantId' | 'agent_id' | 'cadence'> | null;
  /** The run row the outcome moved, as `recordRunOutcome` returns it. A skip has none. */
  run?: Pick<
    IScheduleRun,
    | 'scheduleId'
    | 'user'
    | 'tenantId'
    | 'status'
    | 'firedAt'
    | 'settledAt'
    | 'chatProjectId'
    | 'droppedFileIds'
    | 'mcp'
  >;
  /** A skip's status; otherwise the run row's. */
  status?: ScheduleRunStatus;
  /** Whether a Run now started it; omitted when unknown. */
  manual?: boolean;
  /** What the run row does not say: a skip's destination, or the files a fire left behind. */
  hasProject?: boolean;
  droppedFileCount?: number;
  /** Only for a conversation that exists: a run that never started created none. */
  conversationId?: string;
}

/**
 * Reports one scheduled occurrence's outcome, attributed like the client: the owner is the
 * visitor and their tenant, if any, the account. Never throws and never waits on Pendo, so a
 * settlement path can call it anywhere.
 */
export function reportScheduledRun(
  track: PendoTracker | undefined,
  { schedule, run, manual, conversationId, ...report }: ScheduledRunReport,
): void {
  if (track == null) {
    return;
  }
  try {
    const owner = run?.user ?? schedule?.user;
    const status = run?.status ?? report.status;
    const scheduleId = run?.scheduleId ?? schedule?.id;
    if (owner == null || status == null || scheduleId == null) {
      return;
    }
    /** What the run row records, when the outcome wrote one. */
    const recorded =
      run != null
        ? {
            mcpFailureCount: (run.mcp ?? []).filter((item) => item.status !== 'ready').length,
            droppedFileCount: run.droppedFileIds?.length ?? 0,
            hasProject: run.chatProjectId != null,
          }
        : undefined;
    const firedAt = run?.firedAt != null ? new Date(run.firedAt).getTime() : undefined;
    const endedAt = run?.settledAt != null ? new Date(run.settledAt).getTime() : Date.now();
    void track({
      event: 'scheduled_run_completed',
      visitorId: owner.toString(),
      accountId: run?.tenantId ?? schedule?.tenantId,
      properties: {
        status,
        isManual: manual,
        durationMs: firedAt != null ? Math.max(0, endedAt - firedAt) : undefined,
        frequency: schedule?.cadence.frequency,
        mcpFailureCount: recorded?.mcpFailureCount,
        droppedFileCount: report.droppedFileCount ?? recorded?.droppedFileCount,
        hasProject: report.hasProject ?? recorded?.hasProject,
        agent_id: schedule?.agent_id,
        scheduleId,
        conversationId,
      },
    });
  } catch (error) {
    logger.warn('[schedules] could not report a run outcome to Pendo:', error);
  }
}
