const STREAM_CURSOR = '▌';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMentionPattern(botUsername) {
  return new RegExp(`(^|\\s)@${escapeRegExp(botUsername)}(?=$|\\s)`);
}

function sanitizeUserMessage(message, botUsername) {
  const mentionPattern = new RegExp(`(^|\\s)@${escapeRegExp(botUsername)}(?=$|\\s)`, 'g');

  return message.replace(mentionPattern, ' ').replace(/\s{2,}/g, ' ').trim();
}

function stripStreamingCursor(message) {
  return message.endsWith(STREAM_CURSOR) ? message.slice(0, -1) : message;
}

function formatErrorForMattermost(error) {
  const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const cappedDetails = details.slice(0, 12000);
  return `Exception occurred.\n\`\`\`\n${cappedDetails}\n\`\`\``;
}

async function streamReply({ openai, messages, replyId, updateIntervalMs, updatePost }) {
  let latestReply = '';
  let lastUpdateAt = 0;

  const finalReply = await openai.createChatCompletion(messages, {
    stream: true,
    onDelta: async (fullReply) => {
      latestReply = fullReply;
      const now = Date.now();

      if (now - lastUpdateAt < updateIntervalMs) {
        return;
      }

      lastUpdateAt = now;
      await updatePost(replyId, `${fullReply}${STREAM_CURSOR}`);
    },
  });

  return latestReply || finalReply;
}

export function shouldRespondToThread(thread, senderName, botUsername) {
  if (senderName.startsWith('ai-')) {
    return false;
  }

  const mentionPattern = buildMentionPattern(botUsername);
  return thread.order.some((postId) => {
    const post = thread.posts[postId];
    return post ? mentionPattern.test(post.message ?? '') : false;
  });
}

export function buildOpenAIRequestMessages({
  thread,
  botUserId,
  botUsername,
  systemPrompt,
}) {
  const messages = [{
    role: 'system',
    content: systemPrompt,
  }];

  for (const postId of thread.order) {
    const post = thread.posts[postId];

    if (!post) {
      continue;
    }

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
  constructor({ mattermost, openai, config, logger = console }) {
    this.mattermost = mattermost;
    this.openai = openai;
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

    if (!this.botUser) {
      throw new Error('Bot user is not initialized.');
    }

    if (!post || post.user_id === this.botUser.id || post.type) {
      return;
    }

    if (this.processingPostIds.has(post.id)) {
      return;
    }

    this.processingPostIds.add(post.id);

    try {
      const thread = await this.mattermost.getThread(post.id);

      if (!shouldRespondToThread(thread, senderName, this.botUser.username)) {
        return;
      }

      const channel = await this.mattermost.getChannel(post.channel_id);
      const messages = buildOpenAIRequestMessages({
        thread,
        botUserId: this.botUser.id,
        botUsername: this.botUser.username,
        systemPrompt: channel.header ?? '',
      });
      const rootId = post.root_id || post.id;
      const typing = this.mattermost.startTypingLoop(post.channel_id, post.root_id || '');

      try {
        if (this.config.openai.stream) {
          const replyPost = await this.mattermost.createReply({
            channelId: post.channel_id,
            rootId,
            message: '',
          });
          const replyMessage = await streamReply({
            openai: this.openai,
            messages,
            replyId: replyPost.id,
            updateIntervalMs: this.config.openai.streamUpdateIntervalMs,
            updatePost: (postId, message) => this.mattermost.updatePostMessage(postId, message),
          });

          await this.mattermost.updatePostMessage(replyPost.id, replyMessage);
          return;
        }

        const replyMessage = await this.openai.createChatCompletion(messages, {
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
