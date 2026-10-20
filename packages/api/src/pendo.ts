/**
 * FORK: Pendo's server-side Track Event API (see FORK.md). The browser reports through the agent
 * that the install snippet loads; work no browser sees, such as a scheduled run, reports here.
 * Without an integration key there is no tracker, and nothing is sent.
 */
import { logger } from '@librechat/data-schemas';

/** Event names exactly as registered in Pendo, which matches them verbatim: a renamed event
 *  reads as a new, empty track type. The client's events are listed in client/src/lib/pendo.ts. */
export type PendoServerEvent = 'scheduled_run_completed';

/** Strings and booleans group in Pendo's Data Explorer; numbers aggregate. */
export type PendoTrackProperties = Record<string, string | number | boolean | string[] | undefined>;

export interface PendoTrackRequest {
  event: PendoServerEvent;
  /** The id the client identifies the visitor with: the user's id. */
  visitorId: string;
  /** The user's tenant. The client identifies no account without one, so none is sent. */
  accountId?: string;
  /** Most important first: trailing properties are dropped to fit Pendo's limit. */
  properties: PendoTrackProperties;
}

/** Sends one Track Event. Settles once Pendo answers or the request times out, and never
 *  rejects: analytics must not fail the work it records. */
export type PendoTracker = (request: PendoTrackRequest) => Promise<void>;

export interface PendoTrackerOptions {
  /** Pendo's integration key. A secret: pass it in from the environment, never commit it. */
  integrationKey?: string;
  /** Pendo's data host. Defaults to the environment client/index.html loads its agent from. */
  dataHost?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_DATA_HOST = 'data.pendo-dev.pendo-dev.com';
const DEFAULT_TIMEOUT_MS = 5_000;
/** Pendo's limit for a Track Event's properties, measured as `{"properties":{...}}`. */
const MAX_PROPERTIES_BYTES = 512;
/** A long string would crowd every other property out of that limit. */
const MAX_STRING_LENGTH = 100;

/** Drops unset values and caps strings, then removes trailing properties until the payload fits
 *  Pendo's limit, the same way the client's `fitProperties` does. */
function fitProperties(properties: PendoTrackProperties): PendoTrackProperties {
  const entries: Array<[string, PendoTrackProperties[string]]> = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    entries.push([key, typeof value === 'string' ? value.slice(0, MAX_STRING_LENGTH) : value]);
  }
  let fitted: PendoTrackProperties = Object.fromEntries(entries);
  while (
    entries.length > 0 &&
    Buffer.byteLength(JSON.stringify({ properties: fitted })) > MAX_PROPERTIES_BYTES
  ) {
    entries.pop();
    fitted = Object.fromEntries(entries);
  }
  return fitted;
}

function toTrackUrl(dataHost: string): string {
  const base = /^https?:\/\//i.test(dataHost) ? dataHost : `https://${dataHost}`;
  return `${base.replace(/\/+$/, '')}/data/track`;
}

/** A failure's kind, which is all a log may keep: the request it failed carries the key. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const cause = 'cause' in error ? error.cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined;
  return code != null ? `${error.name} (${code})` : error.name;
}

/**
 * The Track Event sender for this deployment, or undefined when no integration key is set, so
 * callers skip building events nobody would send.
 */
export function createPendoTracker({
  integrationKey,
  dataHost,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}: PendoTrackerOptions): PendoTracker | undefined {
  const key = integrationKey?.trim();
  if (!key) {
    return undefined;
  }
  const url = toTrackUrl(dataHost?.trim() || DEFAULT_DATA_HOST);
  return async ({ event, visitorId, accountId, properties }) => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pendo-integration-key': key },
        body: JSON.stringify({
          type: 'track',
          event,
          visitorId,
          ...(accountId ? { accountId } : {}),
          timestamp: Date.now(),
          properties: fitProperties(properties),
        }),
        /** A redirect would carry the key to another host. */
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        logger.warn(`[pendo] Track Event "${event}" was rejected with HTTP ${response.status}`);
      }
    } catch (error) {
      logger.warn(`[pendo] Track Event "${event}" was not sent: ${describeFailure(error)}`);
    }
  };
}
