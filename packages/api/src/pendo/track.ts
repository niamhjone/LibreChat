/**
 * FORK: Pendo Track Events the server sends (see FORK.md), for outcomes no browser observes. The
 * browser's own events go through `client/src/lib/pendo.ts`. Off unless the deployment sets
 * `PENDO_TRACK_EVENT_SECRET`: env-only, because it is a credential and this deployment runs
 * without `librechat.yaml`.
 */
import { logger } from '@librechat/data-schemas';

/** Event names exactly as registered in Pendo, which matches them verbatim: a renamed event
 *  reads as a new, empty track type. */
export type PendoServerEvent =
  | 'scheduled_run_completed'
  | 'user_account_created'
  | 'agent_api_key_first_used';

/** Strings and booleans group in Pendo's Data Explorer; numbers aggregate. */
export type PendoPropertyValue = string | number | boolean | string[] | null | undefined;
export type PendoProperties = Record<string, PendoPropertyValue>;

export type PendoServerTrack = {
  event: PendoServerEvent;
  /** The user's id, as `client/src/lib/pendo/metadata.ts` identifies the visitor. */
  visitorId: string;
  /** The user's tenant, the client's account. Single-tenant deployments have none. */
  accountId?: string;
  /** Most important first: trailing properties are dropped to fit Pendo's limit. */
  properties: PendoProperties;
};

export type PendoTrackConfig = { url: string; secret: string };

/** The Pendo instance this fork reports to, whose agent `client/index.html` loads. */
const DEFAULT_DATA_HOST = 'data.pendo-dev.pendo-dev.com';
/** Pendo's limit for a Track Event's properties, measured as `{"properties":{...}}`. */
const MAX_PROPERTIES_BYTES = 512;
/** A long string would crowd every other property out of that limit. */
const MAX_STRING_LENGTH = 100;
/** Events are sent beside schedule settlement, sign-up and API requests, so a slow Pendo must
 *  never hold a socket for long. */
const REQUEST_TIMEOUT_MS = 5_000;

/** The Track API endpoint and its secret, or null when server-side tracking is off.
 *  `PENDO_DATA_HOST` points it at another Pendo instance. */
export function getPendoTrackConfig(
  env: Record<string, string | undefined> = process.env,
): PendoTrackConfig | null {
  const secret = env.PENDO_TRACK_EVENT_SECRET?.trim();
  if (!secret) {
    return null;
  }
  const host = env.PENDO_DATA_HOST?.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return { url: `https://${host || DEFAULT_DATA_HOST}/data/track`, secret };
}

/**
 * Drops unset values and caps strings, then removes trailing properties until the payload fits
 * Pendo's limit, the same way `client/src/lib/pendo.ts` does.
 */
export function fitPendoProperties(properties: PendoProperties): PendoProperties {
  const entries: Array<[string, PendoPropertyValue]> = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    entries.push([key, typeof value === 'string' ? value.slice(0, MAX_STRING_LENGTH) : value]);
  }
  let fitted: PendoProperties = Object.fromEntries(entries);
  while (
    entries.length > 0 &&
    Buffer.byteLength(JSON.stringify({ properties: fitted })) > MAX_PROPERTIES_BYTES
  ) {
    entries.pop();
    fitted = Object.fromEntries(entries);
  }
  return fitted;
}

/**
 * Sends one Track Event to Pendo's Track API. Never rejects: analytics must not fail the work it
 * records, so callers fire it without awaiting. The secret travels only in the request header.
 */
export async function trackPendoEvent(
  track: PendoServerTrack,
  config: PendoTrackConfig | null = getPendoTrackConfig(),
): Promise<void> {
  if (config == null) {
    return;
  }
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pendo-integration-key': config.secret,
      },
      body: JSON.stringify({
        type: 'track',
        event: track.event,
        visitorId: track.visitorId,
        ...(track.accountId ? { accountId: track.accountId } : {}),
        timestamp: Date.now(),
        properties: fitPendoProperties(track.properties),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(`[pendo] Track event ${track.event} was refused: HTTP ${response.status}`);
    }
    await response.body?.cancel();
  } catch (error) {
    logger.warn(`[pendo] Track event ${track.event} could not be sent:`, error);
  }
}
