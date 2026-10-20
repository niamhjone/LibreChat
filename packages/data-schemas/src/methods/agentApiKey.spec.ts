import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAgentApiKeyModel } from '~/models/agentApiKey';
import { createAgentApiKeyMethods } from './agentApiKey';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createAgentApiKeyMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createAgentApiKeyModel(mongoose);
  methods = createAgentApiKeyMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.AgentApiKey.deleteMany({});
});

const createKey = (expiresAt?: Date) =>
  methods.createAgentApiKey({ userId: new mongoose.Types.ObjectId(), name: 'CI', expiresAt });

/** FORK: `firstUse` drives the Pendo `agent_api_key_first_used` event. */
describe('validateAgentApiKey first use', () => {
  it('reports the first successful use once, with the key’s creation and expiry', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const { key, id, createdAt } = await createKey(expiresAt);

    const first = await methods.validateAgentApiKey(key);
    const second = await methods.validateAgentApiKey(key);

    expect(first).toMatchObject({ firstUse: true, createdAt, expiresAt });
    expect(first?.keyId.toString()).toBe(id);
    expect(second?.firstUse).toBe(false);
  });

  it('gives the first use to exactly one of concurrent requests', async () => {
    const { key } = await createKey();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => methods.validateAgentApiKey(key)),
    );

    expect(results.every((result) => result != null)).toBe(true);
    expect(results.filter((result) => result?.firstUse === true)).toHaveLength(1);
  });

  it('claims nothing for an unknown key', async () => {
    await expect(methods.validateAgentApiKey('sk-unknown')).resolves.toBeNull();
  });
});
