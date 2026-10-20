/**
 * FORK: the server-side Pendo Track Events (see FORK.md). Each is sent where its outcome becomes
 * known, from wiring kept to one line in the upstream file.
 */
import { logger } from '@librechat/data-schemas';
import type { IScheduleRun, ScheduleMethods } from '@librechat/data-schemas';
import { getPendoTrackConfig, trackPendoEvent } from './track';

/** The methods that settle a scheduled occurrence, and the read that describes its schedule. */
type ScheduleRunMethods = Pick<
  ScheduleMethods,
  'recordRunOutcome' | 'recordSkippedRun' | 'getScheduleById'
>;

/** What `registerUser` (`api/server/services/AuthService.js`) reports of an account it inserted. */
export type CreatedAccount = {
  id: string;
  role?: string;
  provider?: string;
  tenantId?: string;
  emailVerificationRequired?: boolean;
};

/** An ISO timestamp, or nothing for a missing or invalid date. */
function toIsoString(value: Date | string | undefined): string | undefined {
  const time = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** How long the occurrence ran, from its fire to its settlement. A skip never ran. */
function getDurationMs(run: IScheduleRun): number | undefined {
  if (run.durationMs != null) {
    return run.durationMs;
  }
  if (run.firedAt == null || run.settledAt == null) {
    return undefined;
  }
  return new Date(run.settledAt).getTime() - new Date(run.firedAt).getTime();
}

/**
 * Sends `scheduled_run_completed` for an occurrence a call just settled. The schedule is read
 * afterwards, so the event carries an auto-disable that the settlement applied. Never the prompt
 * or the run's error text.
 */
async function reportScheduledRun(
  methods: Pick<ScheduleMethods, 'getScheduleById'>,
  run: IScheduleRun,
): Promise<void> {
  if (run.user == null) {
    return;
  }
  const schedule = await methods.getScheduleById(run.scheduleId).catch(() => null);
  const mcp = run.mcp ?? [];
  await trackPendoEvent({
    event: 'scheduled_run_completed',
    visitorId: String(run.user),
    accountId: run.tenantId ?? schedule?.tenantId,
    properties: {
      status: run.status,
      scheduleId: run.scheduleId,
      agent_id: schedule?.agent_id,
      frequency: schedule?.cadence?.frequency,
      scheduleDisabled: schedule == null ? undefined : schedule.enabled === false,
      disabledReason: schedule?.disabledReason,
      durationMs: getDurationMs(run),
      mcpFailureCount: mcp.filter((outcome) => outcome.status !== 'ready').length,
      mcpStatuses: [...new Set(mcp.map((outcome) => outcome.status))],
      failureCount: schedule?.failureCount,
      runCount: schedule?.runCount,
      scheduledFor: toIsoString(run.scheduledFor),
      conversationId: run.conversationId,
    },
  });
}

/**
 * Reports `scheduled_run_completed` once per scheduled occurrence that reaches its outcome. Every
 * settlement path (the generation owner, reconciliation, deletion, a fire-time failure or skip)
 * records through these two methods, and each resolves to the run only for the call that settled
 * it. Returns `methods` itself when Pendo is not configured. Otherwise the result inherits every
 * other method from `methods`, so a method reassigned on either object is still the one called.
 */
export function withScheduleRunTracking<T extends ScheduleRunMethods>(methods: T): T {
  if (methods == null || getPendoTrackConfig() == null) {
    return methods;
  }
  const report = (run: IScheduleRun | null) => {
    if (run == null) {
      return;
    }
    reportScheduledRun(methods, run).catch((error) => {
      logger.warn('[pendo] Could not report a scheduled run:', error);
    });
  };
  const tracking: Pick<ScheduleMethods, 'recordRunOutcome' | 'recordSkippedRun'> = {
    recordRunOutcome: async (params) => {
      const settled = await methods.recordRunOutcome(params);
      report(settled);
      return settled;
    },
    recordSkippedRun: async (data, balanceSkipDisableThreshold) => {
      const recorded = await methods.recordSkippedRun(data, balanceSkipDisableThreshold);
      report(recorded);
      return recorded;
    },
  };
  return Object.assign(Object.create(methods) as T, tracking);
}

/**
 * Sends `user_account_created` only for a registration that inserted an account: the route
 * answers the same 200 when the email is already registered, so neither its response nor the
 * page can tell the two apart.
 */
export function trackUserAccountCreated(
  result: { userCreated?: boolean; createdUser?: CreatedAccount },
  context: { hasInviteToken: boolean },
): void {
  const account = result?.userCreated === true ? result.createdUser : undefined;
  if (!account?.id) {
    return;
  }
  void trackPendoEvent({
    event: 'user_account_created',
    visitorId: account.id,
    accountId: account.tenantId,
    properties: {
      provider: account.provider,
      role: account.role,
      emailVerificationRequired: account.emailVerificationRequired,
      hasInviteToken: context.hasInviteToken,
      tenantId: account.tenantId,
    },
  });
}

/** The Agents API surface a request used: its mount and leading named segments, never an id. */
export function toApiRoute(req: { baseUrl?: string; path?: string }): string {
  const segments = [req.baseUrl ?? ''];
  for (const segment of (req.path ?? '').split('/').slice(1)) {
    if (!/^[a-z]+$/.test(segment)) {
      break;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Sends `agent_api_key_first_used` the first time a key authenticates. `validateAgentApiKey`
 * claims `firstUse` with a conditional write, so concurrent first requests report it once. Never
 * the key or its hash.
 */
export function trackAgentApiKeyFirstUsed(
  req: { user?: { id?: string; tenantId?: string }; baseUrl?: string; path?: string },
  key: { keyId: { toString(): string }; firstUse?: boolean; createdAt?: Date; expiresAt?: Date },
): void {
  const userId = req.user?.id;
  if (key.firstUse !== true || !userId) {
    return;
  }
  const createdAt = key.createdAt == null ? NaN : new Date(key.createdAt).getTime();
  void trackPendoEvent({
    event: 'agent_api_key_first_used',
    visitorId: userId,
    accountId: req.user?.tenantId,
    properties: {
      keyId: key.keyId.toString(),
      apiRoute: toApiRoute(req),
      keyAgeMinutes: Number.isFinite(createdAt)
        ? Math.max(0, Math.round((Date.now() - createdAt) / 60_000))
        : undefined,
      hasExpiration: key.expiresAt != null,
      tenantId: req.user?.tenantId,
    },
  });
}
