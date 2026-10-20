import { Types } from 'mongoose';
import type { ISchedule, IScheduleRun } from '@librechat/data-schemas';
import { reportScheduledRun } from './pendo';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
}));

const owner = new Types.ObjectId();

const schedule: Pick<ISchedule, 'id' | 'user' | 'tenantId' | 'agent_id' | 'cadence'> = {
  id: 'schedule-1',
  user: owner,
  agent_id: 'agent_1',
  cadence: { frequency: 'daily', hour: 9, minute: 0 },
};

const run = (overrides: Partial<IScheduleRun> = {}): IScheduleRun => ({
  scheduleId: 'schedule-1',
  user: owner,
  scheduledFor: new Date('2026-10-20T09:00:00.000Z'),
  firedAt: new Date('2026-10-20T09:00:00.000Z'),
  settledAt: new Date('2026-10-20T09:00:42.000Z'),
  status: 'success',
  chatProjectId: null,
  ...overrides,
});

describe('reportScheduledRun', () => {
  it('reports the outcome the run row took, attributed to its owner and tenant', () => {
    const track = jest.fn().mockResolvedValue(undefined);

    reportScheduledRun(track, {
      schedule,
      run: run({
        status: 'error',
        tenantId: 'tenant-1',
        chatProjectId: 'project-1',
        mcp: [
          { server: 'github', status: 'ready' },
          { server: 'jira', status: 'mcp_reauth_required' },
        ],
      }),
      manual: true,
      conversationId: 'conversation-1',
    });

    expect(track).toHaveBeenCalledWith({
      event: 'scheduled_run_completed',
      visitorId: owner.toString(),
      accountId: 'tenant-1',
      properties: {
        status: 'error',
        isManual: true,
        durationMs: 42_000,
        frequency: 'daily',
        mcpFailureCount: 1,
        droppedFileCount: 0,
        hasProject: true,
        agent_id: 'agent_1',
        scheduleId: 'schedule-1',
        conversationId: 'conversation-1',
      },
    });
  });

  it('reports a skip from what the fire resolved, with no run row to measure', () => {
    const track = jest.fn().mockResolvedValue(undefined);

    reportScheduledRun(track, {
      schedule,
      status: 'skipped_overlap',
      manual: false,
      hasProject: false,
      droppedFileCount: 2,
    });

    expect(track).toHaveBeenCalledWith(
      expect.objectContaining({
        visitorId: owner.toString(),
        accountId: undefined,
        properties: expect.objectContaining({
          status: 'skipped_overlap',
          isManual: false,
          durationMs: undefined,
          mcpFailureCount: undefined,
          droppedFileCount: 2,
          hasProject: false,
        }),
      }),
    );
  });

  it('still reports from the run row once the schedule is gone', () => {
    const track = jest.fn().mockResolvedValue(undefined);

    reportScheduledRun(track, {
      schedule: null,
      run: run({ scheduleId: 'schedule-2', droppedFileIds: ['file-1'] }),
    });

    expect(track).toHaveBeenCalledWith(
      expect.objectContaining({
        visitorId: owner.toString(),
        properties: expect.objectContaining({
          status: 'success',
          frequency: undefined,
          agent_id: undefined,
          droppedFileCount: 1,
          scheduleId: 'schedule-2',
        }),
      }),
    );
  });

  it('sends nothing without a tracker or an owner, and never throws', () => {
    const track = jest.fn().mockResolvedValue(undefined);

    expect(() =>
      reportScheduledRun(undefined, { schedule, status: 'skipped_balance' }),
    ).not.toThrow();
    reportScheduledRun(track, { schedule: null, status: 'skipped_balance' });

    expect(track).not.toHaveBeenCalled();
  });
});
