import { EModelEndpoint, EndpointURLs } from 'librechat-data-provider';
import type { TPayload, ChatEvent, ChatTransportOptions } from 'librechat-data-provider';
import type { Transport } from '~/hooks/Chat/contract';
import { trackAssistantRun, trackReply, trackTurn } from './track';

/** The route `api/server/controllers/assistants/chatV2.js` serves. Azure Assistants post to the
 *  v1 route instead. */
const ASSISTANTS_ROUTE = EndpointURLs[EModelEndpoint.assistants];

/**
 * The conversation a start response admitted its turn into. The agents route keys a turn's
 * stream by its conversation id; a start that settled, or lost to a newer generation, admitted
 * nothing.
 */
function getAdmittedConversationId(response: unknown): string | null {
  if (response == null || typeof response !== 'object' || !('streamId' in response)) {
    return null;
  }
  if ('status' in response && (response.status === 'settled' || response.status === 'replaced')) {
    return null;
  }
  const { streamId } = response;
  return typeof streamId === 'string' && streamId !== '' ? streamId : null;
}

/** Reports a stream's FINAL frame, then hands every event on unchanged. */
const reportFinal =
  (onEvent: ChatTransportOptions['onEvent']) =>
  (event: ChatEvent): void => {
    if (event.type === 'final') {
      trackReply(event.data);
    }
    onEvent(event);
  };

/** Reports an Assistants run's prompt and reply, then hands every event on unchanged. */
const reportAssistantRun = (payload: TPayload, onEvent: ChatTransportOptions['onEvent']) => {
  const observe = trackAssistantRun(payload);
  return (event: ChatEvent): void => {
    observe(event);
    onEvent(event);
  };
};

/**
 * Reports the chat's agent traffic to Pendo without changing it. On the agents route: each turn
 * a start request admits, and the reply each attached stream finishes with. `send` carries
 * Assistants runs: one on the Assistants route reports its prompt and reply, and an Azure
 * Assistants run, which posts to the v1 route, passes through untouched.
 */
export function withAgentTracking(transport: Transport): Transport {
  return {
    ...transport,
    start: async (request, options) => {
      const response = await transport.start(request, options);
      const conversationId = getAdmittedConversationId(response);
      if (conversationId != null) {
        trackTurn(request.payload, conversationId);
      }
      return response;
    },
    stream: (auth) => {
      const stream = transport.stream(auth);
      return {
        send: (request, options) =>
          stream.send(
            request,
            request.server === ASSISTANTS_ROUTE
              ? { ...options, onEvent: reportAssistantRun(request.payload, options.onEvent) }
              : options,
          ),
        reconnectToStream: (request, options) =>
          stream.reconnectToStream(request, { ...options, onEvent: reportFinal(options.onEvent) }),
      };
    },
  };
}
