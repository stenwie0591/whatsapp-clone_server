import { withFilter } from 'apollo-server-express';
import { GraphQLDateTime } from 'graphql-iso-date';
import { User, Message, Chat, chats, messages, users } from '../db';
import { Resolvers } from '../types/graphql';
import { secret, expiration } from '../env';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { validateLength, validatePassword } from '../validators';

const resolvers: Resolvers = {
  Date: GraphQLDateTime,

  Message: {
    chat(message) {
      return chats.find(c => c.messages.some(m => m === message.id)) || null;
    },

    sender(message) {
      return users.find(u => u.id === message.sender) || null;
    },

    recipient(message) {
      return users.find(u => u.id === message.recipient) || null;
    },

    isMine(message, args, { currentUser }) {
      return message.sender === currentUser.id;
    },
  },

  Chat: {
    name(chat, args, { currentUser }) {
      if (!currentUser) return null;

      const participantId = chat.participants.find(p => p !== currentUser.id);

      if (!participantId) return null;

      const participant = users.find(u => u.id === participantId);

      return participant ? participant.name : null;
    },

    picture(chat, args, { currentUser }) {
      if (!currentUser) return null;

      const participantId = chat.participants.find(p => p !== currentUser.id);

      if (!participantId) return null;

      const participant = users.find(u => u.id === participantId);

      return participant ? participant.picture : null;
    },

    messages(chat) {
      return messages.filter(m => chat.messages.includes(m.id));
    },

    lastMessage(chat) {
      const lastMessage = chat.messages[chat.messages.length - 1];

      return messages.find(m => m.id === lastMessage) || null;
    },

    participants(chat) {
      return chat.participants
        .map(p => users.find(u => u.id === p))
        .filter(Boolean) as User[];
    },
  },

  Query: {
    me(root, args, { currentUser }) {
      return currentUser || null;
    },

    chats(root, args, { currentUser }) {
      if (!currentUser) return [];

      return chats.filter(c => c.participants.includes(currentUser.id));
    },

    chat(root, { chatId }, { currentUser }) {
      if (!currentUser) return null;

      const chat = chats.find(c => c.id === chatId);

      if (!chat) return null;

      return chat.participants.includes(currentUser.id) ? chat : null;
    },

    users(root, args, { currentUser }) {
      if (!currentUser) return [];

      return users.filter(u => u.id !== currentUser.id);
    },
  },

  Mutation: {
    signIn(root, { username, password }, { res }) {
      const user = users.find(u => u.username === username);

      if (!user) {
        throw new Error('user not found');
      }

      const passwordsMatch = bcrypt.compareSync(password, user.password);

      if (!passwordsMatch) {
        throw new Error('password is incorrect');
      }

      const authToken = jwt.sign(username, secret);

      res.cookie('authToken', authToken, { maxAge: expiration });

      return user;
    },

    signUp(root, { name, username, password, passwordConfirm }) {
      validateLength('req.name', name, 3, 50);
      validateLength('req.username', username, 3, 18);
      validatePassword('req.password', password);

      if (password !== passwordConfirm) {
        throw Error("req.password and req.passwordConfirm don't match");
      }

      if (users.some(u => u.username === username)) {
        throw Error('username already exists');
      }

      const passwordHash = bcrypt.hashSync(password, bcrypt.genSaltSync(8));

      const user: User = {
        id: String(users.length + 1),
        password: passwordHash,
        picture: '',
        username,
        name,
      };

      users.push(user);

      return user;
    },

    addMessage(root, { chatId, content }, { currentUser, pubsub }) {
      if (!currentUser) return null;

      const chatIndex = chats.findIndex(c => c.id === chatId);

      if (chatIndex === -1) return null;

      const chat = chats[chatIndex];

      if (!chat.participants.includes(currentUser.id)) return null;

      const recentMessage = messages[messages.length - 1];
      const messageId = String(Number(recentMessage.id) + 1);
      const message: Message = {
        id: messageId,
        createdAt: new Date(),
        sender: currentUser.id,
        recipient: chat.participants.find(p => p !== currentUser.id) as string,
        content,
      };

      messages.push(message);
      chat.messages.push(messageId);
      // The chat will appear at the top of the ChatsList component
      chats.splice(chatIndex, 1);
      chats.unshift(chat);

      pubsub.publish('messageAdded', {
        messageAdded: message,
      });

      return message;
    },

    addChat(root, { recipientId }, { currentUser, pubsub }) {
      if (!currentUser) return null;
      if (!users.some(u => u.id === recipientId)) return null;

      let chat = chats.find(
        c =>
          c.participants.includes(currentUser.id) &&
          c.participants.includes(recipientId)
      );

      if (chat) return chat;

      const chatsIds = chats.map(c => Number(c.id));

      chat = {
        id: String(Math.max(...chatsIds) + 1),
        participants: [currentUser.id, recipientId],
        messages: [],
      };

      chats.push(chat);

      pubsub.publish('chatAdded', {
        chatAdded: chat,
      });

      return chat;
    },

    removeChat(root, { chatId }, { currentUser, pubsub }) {
      if (!currentUser) return null;

      const chatIndex = chats.findIndex(c => c.id === chatId);

      if (chatIndex === -1) return null;

      const chat = chats[chatIndex];

      if (!chat.participants.some(p => p === currentUser.id)) return null;

      chat.messages.forEach(chatMessage => {
        const chatMessageIndex = messages.findIndex(m => m.id === chatMessage);

        if (chatMessageIndex !== -1) {
          messages.splice(chatMessageIndex, 1);
        }
      });

      chats.splice(chatIndex, 1);

      pubsub.publish('chatRemoved', {
        chatRemoved: chat.id,
        targetChat: chat,
      });

      return chatId;
    },
  },

  Subscription: {
    messageAdded: {
      subscribe: withFilter(
        (root, args, { pubsub }) => pubsub.asyncIterator('messageAdded'),
        ({ messageAdded }, args, { currentUser }) => {
          if (!currentUser) return false;

          return [messageAdded.sender, messageAdded.recipient].includes(
            currentUser.id
          );
        }
      ),
    },

    chatAdded: {
      subscribe: withFilter(
        (root, args, { pubsub }) => pubsub.asyncIterator('chatAdded'),
        ({ chatAdded }: { chatAdded: Chat }, args, { currentUser }) => {
          if (!currentUser) return false;

          return chatAdded.participants.some(p => p === currentUser.id);
        }
      ),
    },

    chatRemoved: {
      subscribe: withFilter(
        (root, args, { pubsub }) => pubsub.asyncIterator('chatRemoved'),
        ({ targetChat }: { targetChat: Chat }, args, { currentUser }) => {
          if (!currentUser) return false;

          return targetChat.participants.some(p => p === currentUser.id);
        }
      ),
    },
  },
};

export default resolvers;
