import { logger } from '@librechat/data-schemas';
import { createPendoTracker } from './pendo';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
}));

/** Not a real key: only that it travels in the header, and nowhere else, is under test. */
const KEY = 'integration-key-under-test';

const respondWith = (status: number) => jest.fn().mockResolvedValue(new Response(null, { status }));

const sentBody = (fetchImpl: jest.Mock) => JSON.parse(fetchImpl.mock.calls[0][1].body);

describe('createPendoTracker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends nothing without an integration key', () => {
    expect(createPendoTracker({})).toBeUndefined();
    expect(createPendoTracker({ integrationKey: '   ' })).toBeUndefined();
  });

  it('posts a Track Event with the key in its header and unset properties dropped', async () => {
    const fetchImpl = respondWith(200);
    const track = createPendoTracker({ integrationKey: ` ${KEY} `, fetchImpl });

    await track?.({
      event: 'scheduled_run_completed',
      visitorId: 'user-1',
      properties: { status: 'success', isManual: undefined, durationMs: 1200 },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://data.pendo-dev.pendo-dev.com/data/track',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-pendo-integration-key': KEY },
      }),
    );
    expect(sentBody(fetchImpl)).toEqual({
      type: 'track',
      event: 'scheduled_run_completed',
      visitorId: 'user-1',
      timestamp: expect.any(Number),
      properties: { status: 'success', durationMs: 1200 },
    });
  });

  it('sends the account only when there is one, to the configured host', async () => {
    const fetchImpl = respondWith(200);
    const track = createPendoTracker({
      integrationKey: KEY,
      dataHost: 'https://data.example.test/',
      fetchImpl,
    });

    await track?.({
      event: 'scheduled_run_completed',
      visitorId: 'user-1',
      accountId: 'tenant-1',
      properties: {},
    });

    expect(fetchImpl.mock.calls[0][0]).toBe('https://data.example.test/data/track');
    expect(sentBody(fetchImpl)).toEqual(expect.objectContaining({ accountId: 'tenant-1' }));
  });

  it('drops trailing properties until the payload fits Pendo’s limit', async () => {
    const fetchImpl = respondWith(200);
    const track = createPendoTracker({ integrationKey: KEY, fetchImpl });
    const properties = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`property${index}`, 'v'.repeat(200)]),
    );

    await track?.({ event: 'scheduled_run_completed', visitorId: 'user-1', properties });

    const fitted: Record<string, string> = sentBody(fetchImpl).properties;
    const keptKeys = Object.keys(fitted);
    expect(Buffer.byteLength(JSON.stringify({ properties: fitted }))).toBeLessThanOrEqual(512);
    expect(keptKeys.length).toBeGreaterThan(0);
    expect(keptKeys).toEqual(Object.keys(properties).slice(0, keptKeys.length));
    expect(fitted.property0).toHaveLength(100);
  });

  it('never rejects, and logs a failure without the key', async () => {
    const offline = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
      );
    const unreachable = createPendoTracker({ integrationKey: KEY, fetchImpl: offline });
    const rejected = createPendoTracker({ integrationKey: KEY, fetchImpl: respondWith(400) });
    const request = {
      event: 'scheduled_run_completed' as const,
      visitorId: 'user-1',
      properties: {},
    };

    await expect(unreachable?.(request)).resolves.toBeUndefined();
    await expect(rejected?.(request)).resolves.toBeUndefined();

    const logged = jest.mocked(logger.warn).mock.calls.map((call) => call.join(' '));
    expect(logged).toEqual([
      expect.stringContaining('TypeError (ENOTFOUND)'),
      expect.stringContaining('HTTP 400'),
    ]);
    expect(logged.join(' ')).not.toContain(KEY);
  });
});
