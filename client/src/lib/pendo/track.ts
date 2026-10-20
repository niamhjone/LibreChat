import { v4 } from 'uuid';
import {
  ContentTypes,
  getSpeechText,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  isUserInitiatedCompaction,
} from 'librechat-data-provider';
import type {
  TPayload,
  TMessage,
  ChatFinalFrame,
  TFeedbackRating,
  TMessageContentParts,
} from 'librechat-data-provider';
import logger from '~/utils/logger';

/**
 * The Pendo agent for `api/server/controllers/agents/client.js`, which runs every turn the
 * agents chat route admits: saved agents, and the ephemeral agent behind each model endpoint.
 */
export const AGENT_ID = 'okyDDuCBgMFneiBIim_Q0mqcwqs';

type AgentEventType = 'prompt' | 'agent_response' | 'user_reaction';

/** The metadata `pendo.trackAgent` accepts. */
type AgentMetadata = {
  agentId: string;
  conversationId: string;
  messageId: string;
  /** The message text, or the reaction for a `user_reaction`. */
  content: string;
  modelUsed?: string;
  suggestedPrompt?: boolean;
  toolsUsed?: string[];
  fileUploaded?: boolean;
};

type AgentEvent = Omit<AgentMetadata, 'agentId'> & { type: AgentEventType };

type ToolCall = Extract<TMessageContentParts, { type: ContentTypes.TOOL_CALL }>['tool_call'];

declare global {
  /** Set by the Pendo snippet, when the deployment installs it. A global variable rather than a
   *  `Window` member, so it composes with an install that types `window.pendo` for its own calls. */
  var pendo:
    | { trackAgent?: (eventType: AgentEventType, metadata: AgentMetadata) => void }
    | undefined;
}

const RATING_REACTIONS: Record<TFeedbackRating, string> = {
  thumbsUp: 'positive',
  thumbsDown: 'negative',
};

/** Agent and MCP calls carry a name, function calls name their function, and the Assistants
 *  built-ins are known by their type. */
function getToolName(call: ToolCall): string {
  if ('name' in call) {
    return call.name;
  }
  if ('function' in call) {
    return call.function.name;
  }
  return call.type;
}

/** Each tool the reply called, once, in call order. */
function getToolNames(content: TMessage['content']): string[] {
  const names = new Set<string>();
  for (const part of content ?? []) {
    if (part?.type !== ContentTypes.TOOL_CALL || part.tool_call == null) {
      continue;
    }
    const name = getToolName(part.tool_call);
    if (typeof name === 'string' && name !== '') {
      names.add(name);
    }
  }
  return [...names];
}

/** The model of the reply's final call, persisted with its context usage. Without it, only an
 *  ephemeral agent's reply names its model: a saved agent's reply carries the agent id. */
function getModel(message: Partial<TMessage>): string | undefined {
  const usage = message.metadata?.contextUsage;
  if (
    usage != null &&
    typeof usage === 'object' &&
    'model' in usage &&
    typeof usage.model === 'string'
  ) {
    return usage.model;
  }
  return isAgentsEndpoint(message.endpoint) ? undefined : (message.model ?? undefined);
}

function describeTurn(payload: TPayload, conversationId: string): AgentEvent | null {
  /** A compaction, a continuation and the rerun of an edited reply bring no new input. */
  if (payload.compact === true || payload.isContinued || payload.editedContent != null) {
    return null;
  }
  if (payload.isRegenerate !== true) {
    return {
      type: 'prompt',
      conversationId,
      messageId: payload.messageId ?? v4(),
      content: payload.text ?? '',
      fileUploaded: (payload.files?.length ?? 0) > 0,
    };
  }
  /** A regeneration names the reply it replaces by that reply's id plus a trailing `_`. */
  const messageId = payload.responseMessageId?.replace(/_+$/, '');
  return messageId ? { type: 'user_reaction', conversationId, messageId, content: 'retry' } : null;
}

function describeReply(frame: ChatFinalFrame): AgentEvent | null {
  const message = frame.responseMessage;
  /** A reconcile frame carries no reply, an early abort saved none, and a manual compaction
   *  answers no prompt. */
  if (
    frame.reconcile === true ||
    frame.earlyAbort === true ||
    message?.messageId == null ||
    isUserInitiatedCompaction(message)
  ) {
    return null;
  }
  const conversationId = message.conversationId ?? frame.conversation?.conversationId;
  if (conversationId == null) {
    return null;
  }
  return {
    type: 'agent_response',
    conversationId,
    messageId: message.messageId,
    content: getSpeechText(message),
    modelUsed: getModel(message),
    toolsUsed: getToolNames(message.content),
  };
}

function describeFeedback(
  message: Pick<TMessage, 'messageId' | 'conversationId' | 'endpoint'> | undefined,
  previous: TFeedbackRating | undefined,
  next: TFeedbackRating | undefined,
): AgentEvent | null {
  /** Clearing a rating, or saving the text of one already set, is not a new reaction; and an
   *  Assistants reply comes from the Assistants API, not this agent. */
  if (
    next == null ||
    next === previous ||
    message?.conversationId == null ||
    isAssistantsEndpoint(message.endpoint)
  ) {
    return null;
  }
  return {
    type: 'user_reaction',
    conversationId: message.conversationId,
    messageId: message.messageId,
    content: RATING_REACTIONS[next],
  };
}

/** Reporting runs inside the chat's own request, stream and click handlers, so a page without
 *  Pendo, or a Pendo that throws, must leave the chat exactly as it was. */
function report(describe: () => AgentEvent | null): void {
  try {
    const event = describe();
    if (event == null) {
      return;
    }
    const { type, ...metadata } = event;
    globalThis.pendo?.trackAgent?.(type, { agentId: AGENT_ID, ...metadata });
  } catch (error) {
    logger.warn('pendo', 'Failed to track an agent event', error);
  }
}

/** Reports the turn a start request admitted: a new prompt, or a retry of the reply it
 *  regenerates. */
export function trackTurn(payload: TPayload, conversationId: string): void {
  report(() => describeTurn(payload, conversationId));
}

/** Reports the reply a stream's FINAL frame carries, stopped replies included. */
export function trackReply(frame: ChatFinalFrame): void {
  report(() => describeReply(frame));
}

/** Reports a thumbs rating newly set on a reply. */
export function trackFeedback(
  message: Pick<TMessage, 'messageId' | 'conversationId' | 'endpoint'> | undefined,
  previous: TFeedbackRating | undefined,
  next: TFeedbackRating | undefined,
): void {
  report(() => describeFeedback(message, previous, next));
}
