import type { ISchedule, IScheduleRun, ScheduleMethods } from '@librechat/data-schemas';
import {
  toApiRoute,
  trackUserAccountCreated,
  withScheduleRunTracking,
  trackAgentApiKeyFirstUsed,
} from './events';

/** The event is sent without awaiting; this lets its read and request settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const settledRun = {
  scheduleId: 'schedule-1',
  user: 'user-1',
  tenantId: 'tenant-1',
  scheduledFor: new Date('2026-10-20T08:00:00.000Z'),
  firedAt: new Date('2026-10-20T08:00:00.000Z'),
  settledAt: new Date('2026-10-20T08:00:42.000Z'),
  status: 'success',
  conversationId: 'conversation-1',
  mcp: [
    { server: 'files', status: 'ready' },
    { server: 'mail', status: 'mcp_reauth_required' },
  ],
} as unknown as IScheduleRun;

const schedule = {
  id: 'schedule-1',
  user: 'user-1',
  prompt: 'Summarize my inbox',
  agent_id: 'agent_digest',
  cadence: { frequency: 'daily', hour: 8, minute: 0 },
  enabled: true,
  runCount: 3,
  failureCount: 0,
} as unknown as ISchedule;

function makeMethods(run: IScheduleRun | null, current: ISchedule | null = schedule) {
  return {
    recordRunOutcome: jest.fn(async () => run),
    recordSkippedRun: jest.fn(async () => run),
    getScheduleById: jest.fn(async () => current),
    countActiveRuns: jest.fn(async () => 0),
  };
}

const outcome = {
  scheduleId: 'schedule-1',
  scheduledFor: new Date('2026-10-20T08:00:00.000Z'),
  status: 'success' as const,
  autoDisableAfterFailures: 5,
};

let fetchMock: jest.SpiedFunction<typeof fetch>;

const sentBodies = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

beforeEach(() => {
  process.env.PENDO_TRACK_EVENT_SECRET = 'test-track-secret';
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  delete process.env.PENDO_TRACK_EVENT_SECRET;
  jest.restoreAllMocks();
});

describe('withScheduleRunTracking', () => {
  it('returns the methods themselves when Pendo is not configured', () => {
    delete process.env.PENDO_TRACK_EVENT_SECRET;
    const methods = makeMethods(settledRun) as unknown as ScheduleMethods;

    expect(withScheduleRunTracking(methods)).toBe(methods);
  });

  it('reports a settled occurrence once, after reading its schedule', async () => {
    const methods = makeMethods(settledRun);
    const tracked = withScheduleRunTracking(methods as unknown as ScheduleMethods);

    await expect(tracked.recordRunOutcome(outcome)).resolves.toBe(settledRun);
    await flush();

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(outcome);
    expect(methods.getScheduleById).toHaveBeenCalledWith('schedule-1');
    expect(sentBodies()).toEqual([
      {
        type: 'track',
        event: 'scheduled_run_completed',
        visitorId: 'user-1',
        accountId: 'tenant-1',
        timestamp: expect.any(Number),
        properties: {
          status: 'success',
          scheduleId: 'schedule-1',
          agent_id: 'agent_digest',
          frequency: 'daily',
          scheduleDisabled: false,
          durationMs: 42_000,
          mcpFailureCount: 1,
          mcpStatuses: ['ready', 'mcp_reauth_required'],
          failureCount: 0,
          runCount: 3,
          scheduledFor: '2026-10-20T08:00:00.000Z',
          conversationId: 'conversation-1',
        },
      },
    ]);
    expect(JSON.stringify(sentBodies())).not.toContain('Summarize my inbox');
  });

  it('reports the auto-disable a settlement applied', async () => {
    const methods = makeMethods(settledRun, {
      ...schedule,
      enabled: false,
      disabledReason: 'too_many_failures',
    } as ISchedule);
    const tracked = withScheduleRunTracking(methods as unknown as ScheduleMethods);

    await tracked.recordRunOutcome(outcome);
    await flush();

    expect(sentBodies()[0].properties).toMatchObject({
      scheduleDisabled: true,
      disabledReason: 'too_many_failures',
    });
  });

  it('sends nothing for a call that settled nothing', async () => {
    const methods = makeMethods(null);
    const tracked = withScheduleRunTracking(methods as unknown as ScheduleMethods);

    await expect(tracked.recordRunOutcome(outcome)).resolves.toBeNull();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a recorded skip', async () => {
    const skip = {
      ...settledRun,
      status: 'skipped_overlap',
      settledAt: settledRun.firedAt,
      mcp: undefined,
    } as unknown as IScheduleRun;
    const tracked = withScheduleRunTracking(makeMethods(skip) as unknown as ScheduleMethods);

    await tracked.recordSkippedRun({
      scheduleId: 'schedule-1',
      scheduledFor: outcome.scheduledFor,
      status: 'skipped_overlap',
    });
    await flush();

    expect(sentBodies()[0].properties).toMatchObject({
      status: 'skipped_overlap',
      durationMs: 0,
      mcpFailureCount: 0,
      mcpStatuses: [],
    });
  });

  it('keeps every other method, including one reassigned after wrapping', async () => {
    const methods = makeMethods(settledRun);
    const tracked = withScheduleRunTracking(methods as unknown as ScheduleMethods);
    const replaced = jest.fn(async () => 7);
    methods.countActiveRuns = replaced;

    await expect(tracked.countActiveRuns()).resolves.toBe(7);
    expect(replaced).toHaveBeenCalledTimes(1);
  });
});

describe('trackUserAccountCreated', () => {
  const createdUser = {
    id: 'user-1',
    role: 'USER',
    provider: 'local',
    emailVerificationRequired: false,
  };

  it('reports an account the registration inserted', async () => {
    trackUserAccountCreated({ userCreated: true, createdUser }, { hasInviteToken: true });
    await flush();

    expect(sentBodies()).toEqual([
      {
        type: 'track',
        event: 'user_account_created',
        visitorId: 'user-1',
        timestamp: expect.any(Number),
        properties: {
          provider: 'local',
          role: 'USER',
          emailVerificationRequired: false,
          hasInviteToken: true,
        },
      },
    ]);
  });

  it('sends nothing for the same 200 answered to an existing email', async () => {
    trackUserAccountCreated({}, { hasInviteToken: false });
    trackUserAccountCreated({ userCreated: false, createdUser }, { hasInviteToken: false });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('trackAgentApiKeyFirstUsed', () => {
  const req = {
    user: { id: 'user-1', tenantId: 'tenant-1' },
    baseUrl: '/api/agents/v1',
    path: '/chat/completions',
  };

  it('reports a key’s first authentication, never the key', async () => {
    trackAgentApiKeyFirstUsed(req, {
      keyId: 'key-1',
      firstUse: true,
      createdAt: new Date(Date.now() - 90 * 60_000),
    });
    await flush();

    expect(sentBodies()).toEqual([
      {
        type: 'track',
        event: 'agent_api_key_first_used',
        visitorId: 'user-1',
        accountId: 'tenant-1',
        timestamp: expect.any(Number),
        properties: {
          keyId: 'key-1',
          apiRoute: '/api/agents/v1/chat/completions',
          keyAgeMinutes: 90,
          hasExpiration: false,
          tenantId: 'tenant-1',
        },
      },
    ]);
  });

  it('sends nothing for a key that was already used', async () => {
    trackAgentApiKeyFirstUsed(req, { keyId: 'key-1', firstUse: false });
    trackAgentApiKeyFirstUsed(req, { keyId: 'key-1' });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('toApiRoute', () => {
  it.each([
    ['/api/agents/v1', '/chat/completions', '/api/agents/v1/chat/completions'],
    ['/api/agents/v1', '/events/9b1f0c2e-1d3a-4c5b', '/api/agents/v1/events'],
    ['/api/agents/v1', '/models/agent_abc123', '/api/agents/v1/models'],
    ['/api/agents/v1/responses', '/', '/api/agents/v1/responses'],
    ['/api/agents/v1/responses', '/resp_123', '/api/agents/v1/responses'],
  ])('reads %s + %s as %s', (baseUrl, path, expected) => {
    expect(toApiRoute({ baseUrl, path })).toBe(expected);
  });
});
