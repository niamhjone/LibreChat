import type { Types } from 'mongoose';
import type {
  AgentApiKeyCreateResult,
  AgentApiKeyCreateData,
  AgentApiKeyListItem,
  IAgentApiKey,
} from '~/types';
import { hashToken, getRandomValues } from '~/crypto';
import logger from '~/config/winston';

const API_KEY_PREFIX = 'sk-';
const API_KEY_LENGTH = 32;

/** A valid key's owner and id. FORK: plus whether this request claimed the key's first use,
 *  and its creation and expiry, for the Pendo `agent_api_key_first_used` event. */
export type AgentApiKeyValidation = {
  userId: Types.ObjectId;
  keyId: Types.ObjectId;
  firstUse: boolean;
  createdAt?: Date;
  expiresAt?: Date;
};

export function createAgentApiKeyMethods(mongoose: typeof import('mongoose')): {
  createAgentApiKey: (data: AgentApiKeyCreateData) => Promise<AgentApiKeyCreateResult>;
  validateAgentApiKey: (apiKey: string) => Promise<AgentApiKeyValidation | null>;
  listAgentApiKeys: (userId: string | Types.ObjectId) => Promise<AgentApiKeyListItem[]>;
  deleteAgentApiKey: (
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ) => Promise<boolean>;
  deleteAllAgentApiKeys: (userId: string | Types.ObjectId) => Promise<number>;
  getAgentApiKeyById: (
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ) => Promise<AgentApiKeyListItem | null>;
} {
  async function generateApiKey(): Promise<{ key: string; keyHash: string; keyPrefix: string }> {
    const randomPart = await getRandomValues(API_KEY_LENGTH);
    const key = `${API_KEY_PREFIX}${randomPart}`;
    const keyHash = await hashToken(key);
    const keyPrefix = key.slice(0, 8);
    return { key, keyHash, keyPrefix };
  }

  async function createAgentApiKey(data: AgentApiKeyCreateData): Promise<AgentApiKeyCreateResult> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const { key, keyHash, keyPrefix } = await generateApiKey();

      const apiKeyDoc = await AgentApiKey.create({
        userId: data.userId,
        name: data.name,
        keyHash,
        keyPrefix,
        expiresAt: data.expiresAt || undefined,
      });

      return {
        id: apiKeyDoc._id.toString(),
        name: apiKeyDoc.name,
        keyPrefix,
        key,
        createdAt: apiKeyDoc.createdAt,
        expiresAt: apiKeyDoc.expiresAt,
      };
    } catch (error) {
      logger.error('[createAgentApiKey] Error creating API key:', error);
      throw error;
    }
  }

  /**
   * FORK: claims a key's first use by setting `lastUsedAt` only while it is still unset, so one
   * of any concurrent first requests reports it (the Pendo `agent_api_key_first_used` event). A
   * failed write reads as not first rather than failing the request.
   */
  async function claimFirstUse(keyId: Types.ObjectId): Promise<boolean> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const result = await AgentApiKey.updateOne(
        { _id: keyId, lastUsedAt: null },
        { $set: { lastUsedAt: new Date() } },
      );
      return result.modifiedCount === 1;
    } catch (error) {
      logger.error('[validateAgentApiKey] Error claiming first use:', error);
      return false;
    }
  }

  async function validateAgentApiKey(apiKey: string): Promise<AgentApiKeyValidation | null> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const keyHash = await hashToken(apiKey);

      const keyDoc = (await AgentApiKey.findOne({ keyHash }).lean()) as IAgentApiKey | null;

      if (!keyDoc) {
        return null;
      }

      if (keyDoc.expiresAt && new Date(keyDoc.expiresAt) < new Date()) {
        return null;
      }

      // FORK: Pendo `agent_api_key_first_used`; see claimFirstUse.
      const firstUse =
        keyDoc.lastUsedAt == null && (await claimFirstUse(keyDoc._id as Types.ObjectId));

      AgentApiKey.updateOne({ _id: keyDoc._id }, { $set: { lastUsedAt: new Date() } }).catch(
        (error: unknown) => {
          logger.error('[validateAgentApiKey] Error updating lastUsedAt:', error);
        },
      );

      return {
        userId: keyDoc.userId,
        keyId: keyDoc._id as Types.ObjectId,
        firstUse,
        createdAt: keyDoc.createdAt,
        expiresAt: keyDoc.expiresAt,
      };
    } catch (error) {
      logger.error('[validateAgentApiKey] Error validating API key:', error);
      return null;
    }
  }

  async function listAgentApiKeys(userId: string | Types.ObjectId): Promise<AgentApiKeyListItem[]> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const keys = (await AgentApiKey.find({ userId })
        .sort({ createdAt: -1 })
        .lean()) as unknown as IAgentApiKey[];

      return keys.map((key) => ({
        id: (key._id as Types.ObjectId).toString(),
        name: key.name,
        keyPrefix: key.keyPrefix,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      }));
    } catch (error) {
      logger.error('[listAgentApiKeys] Error listing API keys:', error);
      throw error;
    }
  }

  async function deleteAgentApiKey(
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ): Promise<boolean> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const result = await AgentApiKey.deleteOne({ _id: keyId, userId });
      return result.deletedCount > 0;
    } catch (error) {
      logger.error('[deleteAgentApiKey] Error deleting API key:', error);
      throw error;
    }
  }

  async function deleteAllAgentApiKeys(userId: string | Types.ObjectId): Promise<number> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const result = await AgentApiKey.deleteMany({ userId });
      return result.deletedCount;
    } catch (error) {
      logger.error('[deleteAllAgentApiKeys] Error deleting all API keys:', error);
      throw error;
    }
  }

  async function getAgentApiKeyById(
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ): Promise<AgentApiKeyListItem | null> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const keyDoc = (await AgentApiKey.findOne({
        _id: keyId,
        userId,
      }).lean()) as IAgentApiKey | null;

      if (!keyDoc) {
        return null;
      }

      return {
        id: (keyDoc._id as Types.ObjectId).toString(),
        name: keyDoc.name,
        keyPrefix: keyDoc.keyPrefix,
        lastUsedAt: keyDoc.lastUsedAt,
        expiresAt: keyDoc.expiresAt,
        createdAt: keyDoc.createdAt,
      };
    } catch (error) {
      logger.error('[getAgentApiKeyById] Error getting API key:', error);
      throw error;
    }
  }

  return {
    createAgentApiKey,
    validateAgentApiKey,
    listAgentApiKeys,
    deleteAgentApiKey,
    deleteAllAgentApiKeys,
    getAgentApiKeyById,
  };
}

export type AgentApiKeyMethods = ReturnType<typeof createAgentApiKeyMethods>;
