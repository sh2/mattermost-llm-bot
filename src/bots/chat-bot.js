const STREAM_CURSOR = '▌';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSenderName(senderName) {
  if (typeof senderName !== 'string') {
    return '';
  }

  return senderName.trim().replace(/^@+/, '');
}

function buildMentionPattern(botUsername) {
  return new RegExp(`(^|\\s)@${escapeRegExp(botUsername)}(?=$|\\s)`);
}

function sanitizeUserMessage(message, botUsername) {
  const mentionPattern = new RegExp(`(^|\\s)@${escapeRegExp(botUsername)}(?=$|\\s)`, 'g');

  return message
    .replace(mentionPattern, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripStreamingCursor(message) {
  return message.endsWith(STREAM_CURSOR) ? message.slice(0, -1) : message;
}

function getThreadPostsInConversationOrder(thread) {
  const posts = Object.values(thread?.posts ?? {}).filter(Boolean);
  const orderIndex = new Map((thread?.order ?? []).map((postId, index) => [postId, index]));

  return posts.sort((left, right) => {
    const leftCreateAt = typeof left.create_at === 'number' ? left.create_at : null;
    const rightCreateAt = typeof right.create_at === 'number' ? right.create_at : null;

    if (leftCreateAt !== null && rightCreateAt !== null && leftCreateAt !== rightCreateAt) {
      return leftCreateAt - rightCreateAt;
    }

    if (!left.root_id && right.root_id) {
      return -1;
    }

    if (left.root_id && !right.root_id) {
      return 1;
    }

    const leftIndex = orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
}

function formatErrorForMattermost(error) {
  const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const cappedDetails = details.slice(0, 12000);
  return `Exception occurred.\n\`\`\`\n${cappedDetails}\n\`\`\``;
}

async function streamReply({ llm, messages, replyId, updateIntervalMs, updatePost }) {
  let latestReply = '';
  let lastUpdateAt = 0;
  let latestReplyId = replyId ?? null;

  const finalReply = await llm.createChatCompletion(messages, {
    stream: true,
    onDelta: async (fullReply) => {
      latestReply = fullReply;
      const now = Date.now();

      if (now - lastUpdateAt < updateIntervalMs) {
        return;
      }

      lastUpdateAt = now;
      latestReplyId = await updatePost(latestReplyId, `${fullReply}${STREAM_CURSOR}`);
    },
  });

  return {
    replyId: latestReplyId,
    replyMessage: finalReply || latestReply,
  };
}

export function shouldRespondToThread(thread, botUsername) {
  const mentionPattern = buildMentionPattern(botUsername);
  return getThreadPostsInConversationOrder(thread).some((post) =>
    mentionPattern.test(post.message ?? ''),
  );
}

export function buildOpenAIRequestMessages({ thread, botUserId, botUsername, systemPrompt }) {
  const messages = [
    {
      role: 'system',
      content: systemPrompt,
    },
  ];

  for (const post of getThreadPostsInConversationOrder(thread)) {
    if (post.user_id === botUserId) {
      messages.push({
        role: 'assistant',
        content: stripStreamingCursor(post.message ?? ''),
      });
      continue;
    }

    messages.push({
      role: 'user',
      content: sanitizeUserMessage(post.message ?? '', botUsername),
    });
  }

  return messages;
}

export class ChatBot {
  constructor({ mattermost, llm, config, logger = console }) {
    this.mattermost = mattermost;
    this.llm = llm;
    this.config = config;
    this.logger = logger;
    this.processingPostIds = new Set();
  }

  async start() {
    this.botUser = await this.mattermost.connect();
    this.unsubscribe = this.mattermost.onPost((event) => this.handlePost(event));
    this.logger.info(`Mattermost bot is ready as @${this.botUser.username}.`);
  }

  async stop() {
    this.unsubscribe?.();
    this.mattermost.close();
  }

  async handlePost(event) {
    try {
      await this.processPost(event);
    } catch (error) {
      this.logger.error('Failed to process Mattermost post.', error);
      await this.reportError(event.post.channel_id, error);
    }
  }

  async processPost(event) {
    const { post, senderName } = event;
    const normalizedSenderName = normalizeSenderName(senderName);

    if (!this.botUser) {
      throw new Error('Bot user is not initialized.');
    }

    if (
      !post ||
      post.user_id === this.botUser.id ||
      normalizedSenderName.startsWith('ai-') ||
      post.type
    ) {
      return;
    }

    if (this.processingPostIds.has(post.id)) {
      return;
    }

    this.processingPostIds.add(post.id);

    try {
      const rootId = post.root_id || post.id;
      const thread = await this.mattermost.getThread(rootId);
      const llmConfig = this.config.llm;

      if (!shouldRespondToThread(thread, this.botUser.username)) {
        return;
      }

      const channel = await this.mattermost.getChannel(post.channel_id);
      const messages = buildOpenAIRequestMessages({
        thread,
        botUserId: this.botUser.id,
        botUsername: this.botUser.username,
        systemPrompt: channel.header ?? '',
      });
      const typing = this.mattermost.startTypingLoop(post.channel_id, post.root_id || '');

      try {
        if (llmConfig.stream) {
          const { replyId, replyMessage } = await streamReply({
            llm: this.llm,
            messages,
            updateIntervalMs: llmConfig.streamUpdateIntervalMs,
            updatePost: async (postId, message) => {
              if (!postId) {
                const replyPost = await this.mattermost.createReply({
                  channelId: post.channel_id,
                  rootId,
                  message,
                });

                return replyPost.id;
              }

              await this.mattermost.updatePostMessage(postId, message);
              return postId;
            },
          });

          if (replyId) {
            await this.mattermost.updatePostMessage(replyId, replyMessage);
          } else {
            await this.mattermost.createReply({
              channelId: post.channel_id,
              rootId,
              message: replyMessage,
            });
          }

          return;
        }

        const replyMessage = await this.llm.createChatCompletion(messages, {
          stream: false,
        });

        await this.mattermost.createReply({
          channelId: post.channel_id,
          rootId,
          message: replyMessage,
        });
      } finally {
        typing.stop();
      }
    } finally {
      this.processingPostIds.delete(post.id);
    }
  }

  async reportError(channelId, error) {
    try {
      await this.mattermost.createErrorPost(channelId, formatErrorForMattermost(error));
    } catch (reportingError) {
      this.logger.error('Failed to report Mattermost error.', reportingError);
    }
  }
}
