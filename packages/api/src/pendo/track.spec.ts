import { logger } from '@librechat/data-schemas';
import type { PendoTrackConfig } from './track';
import { fitPendoProperties, getPendoTrackConfig, trackPendoEvent } from './track';

const config: PendoTrackConfig = {
  url: 'https://data.example.com/data/track',
  secret: 'test-track-secret',
};

const payloadBytes = (properties: object) => Buffer.byteLength(JSON.stringify({ properties }));

describe('getPendoTrackConfig', () => {
  it('is off without the track event secret', () => {
    expect(getPendoTrackConfig({})).toBeNull();
    expect(getPendoTrackConfig({ PENDO_TRACK_EVENT_SECRET: '  ' })).toBeNull();
  });

  it('defaults to the data host of the instance the client agent reports to', () => {
    expect(getPendoTrackConfig({ PENDO_TRACK_EVENT_SECRET: 'secret' })).toEqual({
      url: 'https://data.pendo-dev.pendo-dev.com/data/track',
      secret: 'secret',
    });
  });

  it('accepts another data host, with or without a scheme', () => {
    expect(
      getPendoTrackConfig({
        PENDO_TRACK_EVENT_SECRET: 'secret',
        PENDO_DATA_HOST: 'https://data.example.com/',
      })?.url,
    ).toBe('https://data.example.com/data/track');
    expect(
      getPendoTrackConfig({
        PENDO_TRACK_EVENT_SECRET: 'secret',
        PENDO_DATA_HOST: 'data.example.com',
      })?.url,
    ).toBe('https://data.example.com/data/track');
  });
});

describe('fitPendoProperties', () => {
  it('drops unset values and caps strings', () => {
    const fitted = fitPendoProperties({ status: 'success', model: undefined, id: 'x'.repeat(500) });

    expect(fitted).toEqual({ status: 'success', id: 'x'.repeat(100) });
  });

  it('drops trailing properties until the payload fits Pendo’s limit', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`property${index}`, 'v'.repeat(60)]),
    );

    const keptKeys = Object.keys(fitPendoProperties(properties));

    expect(payloadBytes(properties)).toBeGreaterThan(512);
    expect(payloadBytes(fitPendoProperties(properties))).toBeLessThanOrEqual(512);
    expect(keptKeys.length).toBeGreaterThan(0);
    expect(keptKeys).toEqual(Object.keys(properties).slice(0, keptKeys.length));
  });
});

describe('trackPendoEvent', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts the event to the Track API with the secret in its header only', async () => {
    await trackPendoEvent(
      {
        event: 'user_account_created',
        visitorId: 'user-1',
        accountId: 'tenant-1',
        properties: { role: 'USER', provider: undefined },
      },
      config,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(config.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-pendo-integration-key': config.secret,
    });
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      type: 'track',
      event: 'user_account_created',
      visitorId: 'user-1',
      accountId: 'tenant-1',
      timestamp: expect.any(Number),
      properties: { role: 'USER' },
    });
    expect(String(init.body)).not.toContain(config.secret);
  });

  it('omits the account for a user without a tenant', async () => {
    await trackPendoEvent(
      { event: 'user_account_created', visitorId: 'user-1', properties: {} },
      config,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('accountId');
  });

  it('sends nothing when tracking is off', async () => {
    await trackPendoEvent(
      { event: 'user_account_created', visitorId: 'user-1', properties: {} },
      null,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs a refused or failed request instead of rejecting', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const track = {
      event: 'agent_api_key_first_used' as const,
      visitorId: 'user-1',
      properties: {},
    };

    await expect(trackPendoEvent(track, config)).resolves.toBeUndefined();
    await expect(trackPendoEvent(track, config)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(config.secret);
  });
});
