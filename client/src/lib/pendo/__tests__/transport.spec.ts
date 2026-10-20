import { ContentTypes, EModelEndpoint, EndpointURLs } from 'librechat-data-provider';
import type { ChatEvent, ChatTransportOptions, TPayload } from 'librechat-data-provider';
import type { Transport } from '~/hooks/Chat/contract';
import { AGENT_ID, ASSISTANTS_AGENT_ID } from '../track';
import { withAgentTracking } from '../transport';

const trackAgent = jest.fn();

const request = {
  server: '/api/agents/chat/anthropic',
  payload: {
    conversationId: null,
    isContinued: false,
    isTemporary: false,
    messageId: 'msg-1',
    text: 'Hello',
  } satisfies TPayload,
};

/** The stock transport's shape, answering `start` from the test and handing it each attached
 *  stream's listener. */
function createTransport(start: Transport['start'] = jest.fn()) {
  const listeners: ChatTransportOptions['onEvent'][] = [];
  const send = jest.fn();
  const transport: Transport = {
    stream: jest.fn(() => ({
      send,
      reconnectToStream: (_request, options: ChatTransportOptions) => {
        listeners.push(options.onEvent);
        return { closed: false };
      },
    })),
    start,
    abort: jest.fn(),
    abortRun: jest.fn(),
    steer: jest.fn(),
    cancelSteer: jest.fn(),
    armSteer: jest.fn(),
    listQueued: jest.fn(),
    enqueue: jest.fn(),
    cancelQueued: jest.fn(),
  };
  return { transport, listeners, send };
}

beforeEach(() => {
  /** Where the Pendo snippet installs the agent. */
  window.pendo = { trackAgent };
});

afterEach(() => {
  window.pendo = undefined;
});

describe('withAgentTracking', () => {
  it('reports a prompt once the agents route admits its turn', async () => {
    const response = { streamId: 'convo-1', conversationId: 'convo-1', status: 'started' };
    const { transport } = createTransport(jest.fn(async () => response));

    await expect(withAgentTracking(transport).start(request)).resolves.toBe(response);
    expect(trackAgent).toHaveBeenCalledWith('prompt', {
      agentId: AGENT_ID,
      conversationId: 'convo-1',
      messageId: 'msg-1',
      content: 'Hello',
      fileUploaded: false,
    });
  });

  it('reports nothing for a start that admitted no turn', async () => {
    const settled = createTransport(
      jest.fn(async () => ({ streamId: 'convo-1', status: 'settled' })),
    );
    const offline = createTransport(
      jest.fn(async () => {
        throw new Error('offline');
      }),
    );

    await withAgentTracking(settled.transport).start(request);
    await expect(withAgentTracking(offline.transport).start(request)).rejects.toThrow('offline');
    expect(trackAgent).not.toHaveBeenCalled();
  });

  it('reports the reply a stream finishes with, and hands every event on', () => {
    const { transport, listeners } = createTransport();
    const onEvent = jest.fn();
    const events: ChatEvent[] = [
      { type: 'open' },
      {
        type: 'final',
        data: {
          final: true,
          responseMessage: {
            messageId: 'resp-1',
            conversationId: 'convo-1',
            content: [{ type: ContentTypes.TEXT, text: 'Hi!' }],
          },
        },
      },
    ];

    withAgentTracking(transport).stream({ token: 'token' }).reconnectToStream(
      { url: '/api/agents/chat/stream/convo-1' },
      {
        signal: new AbortController().signal,
        onEvent,
      },
    );
    events.forEach((event) => listeners[0](event));

    expect(onEvent.mock.calls).toEqual(events.map((event) => [event]));
    expect(trackAgent).toHaveBeenCalledTimes(1);
    expect(trackAgent).toHaveBeenCalledWith(
      'agent_response',
      expect.objectContaining({ conversationId: 'convo-1', messageId: 'resp-1', content: 'Hi!' }),
    );
  });

  it('reports an Assistants run, and hands every event on', () => {
    const { transport, send } = createTransport();
    const onEvent = jest.fn();
    const reply = { messageId: 'resp-1', conversationId: 'convo-1', thread_id: 'thread-1' };
    const events: ChatEvent[] = [
      { type: 'open' },
      {
        type: 'sync',
        data: {
          sync: true,
          conversationId: 'convo-1',
          requestMessage: { messageId: 'user-1', conversationId: 'convo-1' },
          responseMessage: reply,
        },
      },
      { type: 'content', data: { ...reply, index: 0, type: ContentTypes.TEXT, text: 'Hi!' } },
      { type: 'final', data: { final: true, conversation: { conversationId: 'convo-1' } } },
    ];

    withAgentTracking(transport)
      .stream({ token: 'token' })
      .send(
        {
          server: EndpointURLs[EModelEndpoint.assistants],
          payload: { ...request.payload, endpoint: EModelEndpoint.assistants, model: 'gpt-4o' },
        },
        { signal: new AbortController().signal, onEvent },
      );
    events.forEach((event) => send.mock.calls[0][1].onEvent(event));

    expect(onEvent.mock.calls).toEqual(events.map((event) => [event]));
    expect(trackAgent.mock.calls).toEqual([
      ['prompt', expect.objectContaining({ agentId: ASSISTANTS_AGENT_ID, messageId: 'user-1' })],
      [
        'agent_response',
        expect.objectContaining({
          agentId: ASSISTANTS_AGENT_ID,
          messageId: 'resp-1',
          content: 'Hi!',
          modelUsed: 'gpt-4o',
        }),
      ],
    ]);
  });

  it('passes Azure Assistants runs through untouched', () => {
    const { transport, send } = createTransport();
    const options = { signal: new AbortController().signal, onEvent: jest.fn() };
    const azureRequest = { ...request, server: EndpointURLs[EModelEndpoint.azureAssistants] };

    withAgentTracking(transport).stream({ token: 'token' }).send(azureRequest, options);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe(options);
  });
});
