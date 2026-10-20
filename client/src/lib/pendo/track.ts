import { v4 } from 'uuid';
import {
  ContentTypes,
  getSpeechText,
  EModelEndpoint,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  isUserInitiatedCompaction,
} from 'librechat-data-provider';
import type {
  TPayload,
  TMessage,
  ChatEvent,
  ChatSyncFrame,
  ChatFinalFrame,
  TFeedbackRating,
  TMessageContentParts,
} from 'librechat-data-provider';
import logger from '~/utils/logger';

/**
 * The Pendo agent for `api/server/controllers/agents/client.js`, which runs every turn the
 * agents chat route admits: saved agents, and the ephemeral agent behind each model endpoint.
 */
export const AGENT_ID = '84uDFtS3YTEbWBjUIwHcEvoBdm0';

/**
 * The Pendo agent for `api/server/controllers/assistants/chatV2.js`, which runs every turn of the
 * Assistants endpoint. Azure Assistants post to the v1 route instead, which no agent covers.
 */
export const ASSISTANTS_AGENT_ID = 'EReZmzcN5riv9HJbIFU60pwxbg4';

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

type AgentEvent = AgentMetadata & { type: AgentEventType };

type ToolCall = Extract<TMessageContentParts, { type: ContentTypes.TOOL_CALL }>['tool_call'];

/** The reply an Assistants run streams. Its FINAL frame carries none, so the reply is built the
 *  way the chat view builds it: each content frame replaces the part at its index. */
type AssistantReply = {
  conversationId: string;
  messageId: string;
  content: TMessageContentParts[];
};

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
      agentId: AGENT_ID,
      conversationId,
      messageId: payload.messageId ?? v4(),
      content: payload.text ?? '',
      fileUploaded: (payload.files?.length ?? 0) > 0,
    };
  }
  /** A regeneration names the reply it replaces by that reply's id plus a trailing `_`. */
  const messageId = payload.responseMessageId?.replace(/_+$/, '');
  return messageId
    ? { type: 'user_reaction', agentId: AGENT_ID, conversationId, messageId, content: 'retry' }
    : null;
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
    agentId: AGENT_ID,
    conversationId,
    messageId: message.messageId,
    content: getSpeechText(message),
    modelUsed: getModel(message),
    toolsUsed: getToolNames(message.content),
  };
}

/** The agent behind a reply, by the endpoint that served it: the Assistants endpoint posts to the
 *  Assistants agent's route, Azure Assistants to the v1 route no agent covers, and every other
 *  endpoint to the agents route. */
function getReplyAgentId(endpoint: TMessage['endpoint']): string | null {
  if (endpoint === EModelEndpoint.assistants) {
    return ASSISTANTS_AGENT_ID;
  }
  return isAssistantsEndpoint(endpoint) ? null : AGENT_ID;
}

function describeFeedback(
  message: Pick<TMessage, 'messageId' | 'conversationId' | 'endpoint'> | undefined,
  previous: TFeedbackRating | undefined,
  next: TFeedbackRating | undefined,
): AgentEvent | null {
  /** Clearing a rating, or saving the text of one already set, is not a new reaction. */
  if (next == null || next === previous || message?.conversationId == null) {
    return null;
  }
  const agentId = getReplyAgentId(message.endpoint);
  if (agentId == null) {
    return null;
  }
  return {
    type: 'user_reaction',
    agentId,
    conversationId: message.conversationId,
    messageId: message.messageId,
    content: RATING_REACTIONS[next],
  };
}

/** The turn an Assistants run admitted. The route saves the user message under an id of its own,
 *  which the `sync` frame names along with the conversation, new or not. */
function describeAssistantTurn(payload: TPayload, frame: ChatSyncFrame): AgentEvent | null {
  const conversationId = frame.conversationId ?? frame.requestMessage?.conversationId;
  const messageId = frame.requestMessage?.messageId;
  if (conversationId == null || messageId == null) {
    return null;
  }
  return {
    type: 'prompt',
    agentId: ASSISTANTS_AGENT_ID,
    conversationId,
    messageId,
    content: payload.text ?? '',
    fileUploaded: (payload.files?.length ?? 0) > 0,
  };
}

function describeAssistantReply(
  payload: TPayload,
  reply: AssistantReply,
  frame: ChatFinalFrame,
): AgentEvent | null {
  /** A failed run ends on the error handler's FINAL frame, which carries the thread's messages
   *  in place of a reply. */
  if (frame.runMessages != null || frame.error != null) {
    return null;
  }
  return {
    type: 'agent_response',
    agentId: ASSISTANTS_AGENT_ID,
    conversationId: reply.conversationId,
    messageId: reply.messageId,
    content: getSpeechText({ content: reply.content }),
    /** The run overrides the assistant's model with the one the request names. */
    modelUsed: payload.model ?? undefined,
    toolsUsed: getToolNames(reply.content),
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
    globalThis.pendo?.trackAgent?.(type, metadata);
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

/**
 * Follows one Assistants run through its stream: reports the prompt once the route admits the
 * turn, and the reply once the run completes. A stopped run reports no reply: its stream closes
 * without a FINAL frame, because the abort route answers instead.
 */
export function trackAssistantRun(payload: TPayload): (event: ChatEvent) => void {
  let admitted = false;
  let reply: AssistantReply | null = null;

  const observe = (event: ChatEvent): AgentEvent | null => {
    if (event.type === 'sync' && !admitted) {
      admitted = true;
      const prompt = describeAssistantTurn(payload, event.data);
      const messageId = event.data.responseMessage?.messageId;
      if (prompt != null && messageId != null) {
        reply = { conversationId: prompt.conversationId, messageId, content: [] };
      }
      return prompt;
    }
    if (event.type === 'content' && event.data.messageId === reply?.messageId) {
      reply.content[event.data.index] = event.data;
      return null;
    }
    if (event.type === 'final' && reply != null) {
      const finished = reply;
      reply = null;
      return describeAssistantReply(payload, finished, event.data);
    }
    return null;
  };

  return (event) => report(() => observe(event));
}
