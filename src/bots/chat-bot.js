import { resizeImageToMaxLongEdge } from '../images/resizer.js';

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

function isImageMimeType(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
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

export async function collectThreadImages({
  thread,
  mattermost,
  resizer,
  maxLongEdge,
  logger = console,
}) {
  const imagesByPostId = {};

  for (const post of getThreadPostsInConversationOrder(thread)) {
    const fileIds = Array.isArray(post.file_ids) ? post.file_ids : [];

    if (fileIds.length === 0) {
      continue;
    }

    let fileInfos;

    try {
      fileInfos = await mattermost.getFileInfosForPost(post.id);
    } catch (error) {
      logger.warn(`Failed to load file infos for post ${post.id}.`, error);
      continue;
    }

    const fileInfoById = new Map(
      (Array.isArray(fileInfos) ? fileInfos : []).map((info) => [info.id, info]),
    );
    const orderedFileInfos = fileIds.map((fileId) => fileInfoById.get(fileId)).filter(Boolean);
    const imageParts = [];

    for (const fileInfo of orderedFileInfos) {
      if (!isImageMimeType(fileInfo.mime_type)) {
        continue;
      }

      try {
        const bytes = await mattermost.getFileContent(fileInfo.id);
        const { bytes: resizedBytes, mimeType } = await resizer(bytes, maxLongEdge);
        const dataUrl = `data:${mimeType};base64,${Buffer.from(resizedBytes).toString('base64')}`;

        imageParts.push({ dataUrl, mimeType });
      } catch (error) {
        logger.warn(`Failed to process image file ${fileInfo.id} for post ${post.id}.`, error);
      }
    }

    if (imageParts.length > 0) {
      imagesByPostId[post.id] = imageParts;
    }
  }

  return imagesByPostId;
}

export function buildOpenAIRequestMessages({
  thread,
  botUserId,
  botUsername,
  systemPrompt,
  imagesByPostId = {},
}) {
  const messages = [
    {
      role: 'system',
      content: systemPrompt,
    },
  ];

  for (const post of getThreadPostsInConversationOrder(thread)) {
    const role = post.user_id === botUserId ? 'assistant' : 'user';
    const textContent =
      role === 'assistant'
        ? stripStreamingCursor(post.message ?? '')
        : sanitizeUserMessage(post.message ?? '', botUsername);
    const imageParts = imagesByPostId[post.id] ?? [];

    if (imageParts.length === 0) {
      messages.push({ role, content: textContent });
      continue;
    }

    messages.push({
      role,
      content: [
        {
          type: 'text',
          text: textContent,
        },
        ...imageParts.map((part) => ({
          type: 'image_url',
          image_url: {
            url: part.dataUrl,
          },
        })),
      ],
    });
  }

  return messages;
}

export class ChatBot {
  constructor({ mattermost, llm, config, logger = console, resizer = resizeImageToMaxLongEdge }) {
    this.mattermost = mattermost;
    this.llm = llm;
    this.config = config;
    this.logger = logger;
    this.resizer = resizer;
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
      const typing = this.mattermost.startTypingLoop(post.channel_id, post.root_id || '');

      try {
        const imagesByPostId = await collectThreadImages({
          thread,
          mattermost: this.mattermost,
          resizer: this.resizer,
          maxLongEdge: this.config.llm.images?.maxLongEdge,
          logger: this.logger,
        });
        const messages = buildOpenAIRequestMessages({
          thread,
          botUserId: this.botUser.id,
          botUsername: this.botUser.username,
          systemPrompt: channel.header ?? '',
          imagesByPostId,
        });

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
