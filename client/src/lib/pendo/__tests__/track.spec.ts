import { ContentTypes, EModelEndpoint, ToolCallTypes } from 'librechat-data-provider';
import type { TPayload, ChatEvent, ChatFinalFrame } from 'librechat-data-provider';
import {
  AGENT_ID,
  ASSISTANTS_AGENT_ID,
  trackAssistantRun,
  trackFeedback,
  trackReply,
  trackTurn,
} from '../track';
import logger from '~/utils/logger';

const trackAgent = jest.fn();

const buildPayload = (overrides: Partial<TPayload> = {}): TPayload => ({
  conversationId: 'convo-1',
  isContinued: false,
  isTemporary: false,
  messageId: 'msg-1',
  text: 'What is 2 + 2?',
  ...overrides,
});

const buildFinal = (overrides: Partial<ChatFinalFrame> = {}): ChatFinalFrame => ({
  final: true,
  conversation: { conversationId: 'convo-1' },
  responseMessage: {
    messageId: 'resp-1',
    conversationId: 'convo-1',
    endpoint: 'anthropic',
    model: 'claude-haiku',
    content: [
      { type: ContentTypes.THINK, think: 'Use the calculator.' },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'call-1',
          name: 'calculator',
          args: '2 + 2',
          type: ToolCallTypes.TOOL_CALL,
        },
      },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: { id: 'call-2', name: 'calculator', args: '4', type: ToolCallTypes.TOOL_CALL },
      },
      { type: ContentTypes.TEXT, text: 'It is 4.' },
    ],
  },
  ...overrides,
});

beforeEach(() => {
  globalThis.pendo = { trackAgent };
});

afterEach(() => {
  globalThis.pendo = undefined;
});

describe('trackTurn', () => {
  it('reports a new turn as a prompt', () => {
    trackTurn(buildPayload({ files: [{ file_id: 'file-1' }] }), 'convo-1');

    expect(trackAgent).toHaveBeenCalledWith('prompt', {
      agentId: AGENT_ID,
      conversationId: 'convo-1',
      messageId: 'msg-1',
      content: 'What is 2 + 2?',
      fileUploaded: true,
    });
  });

  it('reports a regeneration as a retry of the reply it replaces', () => {
    trackTurn(buildPayload({ isRegenerate: true, responseMessageId: 'resp-1_' }), 'convo-1');

    expect(trackAgent).toHaveBeenCalledWith('user_reaction', {
      agentId: AGENT_ID,
      conversationId: 'convo-1',
      messageId: 'resp-1',
      content: 'retry',
    });
  });

  const inputless: Array<[string, Partial<TPayload>]> = [
    ['a compaction', { compact: true }],
    ['a continuation', { isRegenerate: true, isContinued: true }],
    [
      'the rerun of an edited reply',
      {
        isRegenerate: true,
        editedContent: { index: 0, type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Edited' },
      },
    ],
  ];

  it.each(inputless)('reports nothing for %s', (_label, overrides) => {
    trackTurn(buildPayload(overrides), 'convo-1');

    expect(trackAgent).not.toHaveBeenCalled();
  });
});

describe('trackReply', () => {
  it("reports the reply's text, tools and model", () => {
    trackReply(
      buildFinal({
        responseMessage: {
          ...buildFinal().responseMessage,
          metadata: { contextUsage: { model: 'claude-haiku-20260101' } },
        },
      }),
    );

    expect(trackAgent).toHaveBeenCalledWith('agent_response', {
      agentId: AGENT_ID,
      conversationId: 'convo-1',
      messageId: 'resp-1',
      content: 'It is 4.',
      modelUsed: 'claude-haiku-20260101',
      toolsUsed: ['calculator'],
    });
  });

  it("names an ephemeral agent's model, never a saved agent's id", () => {
    trackReply(buildFinal());
    trackReply(
      buildFinal({
        responseMessage: { messageId: 'resp-2', endpoint: 'agents', model: 'agent_abc' },
      }),
    );

    expect(trackAgent).toHaveBeenNthCalledWith(
      1,
      'agent_response',
      expect.objectContaining({ modelUsed: 'claude-haiku' }),
    );
    expect(trackAgent).toHaveBeenNthCalledWith(
      2,
      'agent_response',
      expect.objectContaining({ messageId: 'resp-2', modelUsed: undefined }),
    );
  });

  it('reports a reply the user stopped', () => {
    trackReply(buildFinal({ aborted: true }));

    expect(trackAgent).toHaveBeenCalledWith(
      'agent_response',
      expect.objectContaining({ messageId: 'resp-1', content: 'It is 4.' }),
    );
  });

  const replyless: Array<[string, Partial<ChatFinalFrame>]> = [
    ['a reconcile frame', { reconcile: true, responseMessage: null }],
    ['an early abort', { earlyAbort: true, aborted: true, responseMessage: null }],
    [
      'a manual compaction',
      {
        responseMessage: {
          messageId: 'resp-1',
          conversationId: 'convo-1',
          content: [
            {
              type: ContentTypes.SUMMARY,
              content: [{ type: ContentTypes.TEXT, text: 'Earlier turns' }],
              initiatedBy: 'user',
            },
          ],
        },
      },
    ],
  ];

  it.each(replyless)('reports nothing for %s', (_label, overrides) => {
    trackReply(buildFinal(overrides));

    expect(trackAgent).not.toHaveBeenCalled();
  });
});

describe('trackFeedback', () => {
  const message = { messageId: 'resp-1', conversationId: 'convo-1', endpoint: 'agents' };

  it('reports a newly set rating as a reaction', () => {
    trackFeedback(message, undefined, 'thumbsUp');
    trackFeedback(message, 'thumbsUp', 'thumbsDown');

    expect(trackAgent.mock.calls).toEqual([
      [
        'user_reaction',
        { agentId: AGENT_ID, conversationId: 'convo-1', messageId: 'resp-1', content: 'positive' },
      ],
      [
        'user_reaction',
        { agentId: AGENT_ID, conversationId: 'convo-1', messageId: 'resp-1', content: 'negative' },
      ],
    ]);
  });

  it("reports an Assistants reply's rating as the Assistants agent's", () => {
    trackFeedback({ ...message, endpoint: EModelEndpoint.assistants }, undefined, 'thumbsDown');

    expect(trackAgent).toHaveBeenCalledWith('user_reaction', {
      agentId: ASSISTANTS_AGENT_ID,
      conversationId: 'convo-1',
      messageId: 'resp-1',
      content: 'negative',
    });
  });

  it('reports nothing for a cleared or re-saved rating, or an Azure Assistants reply', () => {
    trackFeedback(message, 'thumbsUp', undefined);
    trackFeedback(message, 'thumbsDown', 'thumbsDown');
    trackFeedback({ ...message, endpoint: EModelEndpoint.azureAssistants }, undefined, 'thumbsUp');

    expect(trackAgent).not.toHaveBeenCalled();
  });
});

describe('trackAssistantRun', () => {
  const payload = buildPayload({
    conversationId: null,
    endpoint: EModelEndpoint.assistants,
    model: 'gpt-4o',
  });

  /** The route saves the turn under ids of its own and names them here. */
  const sync: ChatEvent = {
    type: 'sync',
    data: {
      sync: true,
      conversationId: 'convo-1',
      requestMessage: { messageId: 'user-1', conversationId: 'convo-1', text: 'What is 2 + 2?' },
      responseMessage: { messageId: 'resp-1', conversationId: 'convo-1' },
    },
  };

  const reply = { messageId: 'resp-1', conversationId: 'convo-1', thread_id: 'thread-1' };

  /** Each frame replaces the part at its index: running text, then the annotated text. */
  const streamed: ChatEvent[] = [
    {
      type: 'content',
      data: {
        ...reply,
        index: 0,
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'call-1',
          type: 'code_interpreter',
          code_interpreter: { input: 'print(2 + 2)', outputs: [] },
          progress: 1,
        },
      },
    },
    {
      type: 'content',
      data: {
        ...reply,
        index: 1,
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'call-2',
          type: 'function',
          function: { name: 'lookup', arguments: '{}', output: '4' },
          progress: 1,
        },
      },
    },
    { type: 'content', data: { ...reply, index: 2, type: ContentTypes.TEXT, text: 'It is' } },
    {
      type: 'content',
      data: { ...reply, index: 2, type: ContentTypes.TEXT, text: { value: 'It is 4.' } },
    },
  ];

  const final: ChatEvent = {
    type: 'final',
    data: {
      final: true,
      conversation: { conversationId: 'convo-1' },
      requestMessage: { thread_id: 'thread-1' },
    },
  };

  it('reports the admitted prompt under the ids the route saved it with', () => {
    trackAssistantRun({ ...payload, files: [{ file_id: 'file-1' }] })(sync);

    expect(trackAgent).toHaveBeenCalledWith('prompt', {
      agentId: ASSISTANTS_AGENT_ID,
      conversationId: 'convo-1',
      messageId: 'user-1',
      content: 'What is 2 + 2?',
      fileUploaded: true,
    });
  });

  it('reports the streamed reply once the run completes, and each event once', () => {
    const observe = trackAssistantRun(payload);
    [sync, sync, ...streamed, final, final].forEach(observe);

    expect(trackAgent.mock.calls.map(([type]) => type)).toEqual(['prompt', 'agent_response']);
    expect(trackAgent).toHaveBeenLastCalledWith('agent_response', {
      agentId: ASSISTANTS_AGENT_ID,
      conversationId: 'convo-1',
      messageId: 'resp-1',
      content: 'It is 4.',
      modelUsed: 'gpt-4o',
      toolsUsed: ['code_interpreter', 'lookup'],
    });
  });

  it('reports no reply for a failed run', () => {
    const observe = trackAssistantRun(payload);
    [sync, ...streamed].forEach(observe);
    observe({
      type: 'final',
      data: { final: true, conversation: { conversationId: 'convo-1' }, runMessages: [] },
    });

    expect(trackAgent).toHaveBeenCalledTimes(1);
    expect(trackAgent).toHaveBeenCalledWith('prompt', expect.anything());
  });
});

describe('without a working Pendo', () => {
  it('does nothing when the snippet is not installed', () => {
    globalThis.pendo = undefined;

    expect(() => trackTurn(buildPayload(), 'convo-1')).not.toThrow();
  });

  it('keeps a failing Pendo from reaching the caller', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    trackAgent.mockImplementationOnce(() => {
      throw new Error('pendo failed');
    });

    expect(() => trackReply(buildFinal())).not.toThrow();
    expect(warn).toHaveBeenCalledWith('pendo', expect.any(String), expect.any(Error));
  });
});
