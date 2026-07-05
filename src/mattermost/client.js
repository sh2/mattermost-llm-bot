import mattermostClient from '@mattermost/client';
import NodeWebSocket from 'ws';

const { Client4, WebSocketClient, WebSocketEvents } = mattermostClient;

if (!globalThis.WebSocket) {
  globalThis.WebSocket = NodeWebSocket;
}

export function parsePostedEvent(message) {
  if (message.event !== WebSocketEvents.Posted || !message.data?.post) {
    return null;
  }

  return {
    post: JSON.parse(message.data.post),
    senderName: message.data.sender_name ?? '',
  };
}

export class MattermostService {
  constructor(config, logger = console, fetchImpl = globalThis.fetch) {
    this.url = config.url;
    this.token = config.token;
    this.typingIntervalMs = config.typingIntervalMs;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.postListeners = new Set();
    this.handleMessage = this.handleMessage.bind(this);
  }

  async connect() {
    this.client = new Client4();
    this.client.setUrl(this.url);
    this.client.setToken(this.token);
    this.currentUser = await this.client.getMe();

    this.socket = new WebSocketClient();
    this.socket.addMessageListener(this.handleMessage);
    this.socket.addFirstConnectListener(() => {
      this.logger.info('Connected to Mattermost websocket.');
    });
    this.socket.addReconnectListener(() => {
      this.logger.warn('Reconnected to Mattermost websocket.');
    });
    this.socket.addCloseListener((connectFailCount) => {
      this.logger.warn(`Mattermost websocket closed. reconnectAttempts=${connectFailCount}`);
    });
    this.socket.addErrorListener((event) => {
      this.logger.error('Mattermost websocket error.', event);
    });
    this.socket.initialize(this.client.getWebSocketUrl(), this.token);

    return this.currentUser;
  }

  handleMessage(message) {
    let event;

    try {
      event = parsePostedEvent(message);
    } catch (error) {
      this.logger.error('Failed to parse Mattermost posted event.', error);
      return;
    }

    if (!event) {
      return;
    }

    for (const listener of this.postListeners) {
      Promise.resolve()
        .then(() => listener(event))
        .catch((error) => {
          this.logger.error('Unhandled Mattermost post listener error.', error);
        });
    }
  }

  onPost(listener) {
    this.postListeners.add(listener);
    return () => {
      this.postListeners.delete(listener);
    };
  }

  async getThread(postId) {
    this.ensureClient();
    return this.client.getPostThread(postId);
  }

  async getChannel(channelId) {
    this.ensureClient();
    return this.client.getChannel(channelId);
  }

  async getFileInfosForPost(postId) {
    this.ensureClient();
    return this.client.getFileInfosForPost(postId);
  }

  async getFileContent(fileId) {
    this.ensureClient();

    const fileUrl = this.client.getFileUrl(fileId, Date.now());
    const response = await this.fetchImpl(fileUrl, {
      headers: {
        authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Mattermost file download failed with status ${response.status}: ${fileId}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  async createReply({ channelId, rootId, message }) {
    this.ensureClient();
    return this.client.createPost({
      channel_id: channelId,
      root_id: rootId,
      message,
    });
  }

  async updatePostMessage(postId, message) {
    this.ensureClient();
    return this.client.patchPost({
      id: postId,
      message,
    });
  }

  async createErrorPost(channelId, message) {
    this.ensureClient();
    return this.client.createPost({
      channel_id: channelId,
      message,
    });
  }

  startTypingLoop(channelId, parentId = '') {
    this.sendTyping(channelId, parentId);

    const timer = setInterval(() => {
      this.sendTyping(channelId, parentId);
    }, this.typingIntervalMs);

    return {
      stop: () => {
        clearInterval(timer);
      },
    };
  }

  sendTyping(channelId, parentId = '') {
    if (!this.socket) {
      throw new Error('Mattermost websocket is not connected.');
    }

    try {
      this.socket.userTyping(channelId, parentId);
    } catch (error) {
      this.logger.error('Failed to send Mattermost typing event.', error);
    }
  }

  close() {
    this.socket?.close();
  }

  ensureClient() {
    if (!this.client) {
      throw new Error('Mattermost REST client is not connected.');
    }
  }
}
