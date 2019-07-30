import { GraphQLModule } from '@graphql-modules/core';
import { gql, withFilter } from 'apollo-server-express';
import sql from 'sql-template-strings';
import commonModule from '../common';
import usersModule from '../users';
import { Message, Chat, pool } from '../../db';
import { Resolvers } from '../../types/graphql';
import { UnsplashApi } from './unsplash.api';
import { Users } from './../users/users.provider';
import { Chats } from './chats.provider';
import { PubSub } from '../common/pubsub.provider';

const typeDefs = gql`
  type Message {
    id: ID!
    content: String!
    createdAt: DateTime!
    chat: Chat
    sender: User
    recipient: User
    isMine: Boolean!
  }

  type Chat {
    id: ID!
    name: String
    picture: String
    lastMessage: Message
    messages: [Message!]!
    participants: [User!]!
  }

  extend type Query {
    chats: [Chat!]!
    chat(chatId: ID!): Chat
  }

  extend type Mutation {
    addMessage(chatId: ID!, content: String!): Message
    addChat(recipientId: ID!): Chat
    removeChat(chatId: ID!): ID
  }

  extend type Subscription {
    messageAdded: Message!
    chatAdded: Chat!
    chatRemoved: ID!
  }
`;

const resolvers: Resolvers = {
  Message: {
    createdAt(message) {
      return new Date(message.created_at);
    },

    async chat(message, args, { injector }) {
      return injector.get(Chats).findChatById(message.chat_id);
    },

    async sender(message, args, { injector }) {
      return injector.get(Users).findById(message.sender_user_id);
    },

    async recipient(message, args, { injector }) {
      return injector.get(Chats).firstRecipient({
        chatId: message.chat_id,
        userId: message.sender_user_id,
      });
    },

    isMine(message, args, { currentUser }) {
      return message.sender_user_id === currentUser.id;
    },
  },

  Chat: {
    async name(chat, args, { currentUser, injector }) {
      if (!currentUser) return null;

      const participant = await injector.get(Chats).firstRecipient({
        chatId: chat.id,
        userId: currentUser.id,
      });

      return participant ? participant.name : null;
    },

    async picture(chat, args, { currentUser, db, injector }) {
      if (!currentUser) return null;

      const participant = await injector.get(Chats).firstRecipient({
        chatId: chat.id,
        userId: currentUser.id,
      });

      return participant && participant.picture
        ? participant.picture
        : injector.get(UnsplashApi).getRandomPhoto();
    },

    async messages(chat, args, { injector }) {
      return injector.get(Chats).findMessagesByChat(chat.id);
    },

    async lastMessage(chat, args, { injector }) {
      return injector.get(Chats).lastMessage(chat.id);
    },

    async participants(chat, args, { injector }) {
      return injector.get(Chats).participants(chat.id);
    },
  },

  Query: {
    async chats(root, args, { currentUser, injector }) {
      if (!currentUser) return [];

      return injector.get(Chats).findChatsByUser(currentUser.id);
    },

    async chat(root, { chatId }, { currentUser, injector }) {
      if (!currentUser) return null;

      return injector
        .get(Chats)
        .findChatByUser({ chatId, userId: currentUser.id });
    },
  },

  Mutation: {
    async addMessage(root, { chatId, content }, { currentUser, injector }) {
      if (!currentUser) return null;

      return injector
        .get(Chats)
        .addMessage({ chatId, content, userId: currentUser.id });
    },

    async addChat(root, { recipientId }, { currentUser, injector }) {
      if (!currentUser) return null;

      return injector
        .get(Chats)
        .addChat({ recipientId, userId: currentUser.id });
    },

    async removeChat(root, { chatId }, { currentUser, injector }) {
      if (!currentUser) return null;

      return injector.get(Chats).removeChat({ chatId, userId: currentUser.id });
    },
  },

  Subscription: {
    messageAdded: {
      subscribe: withFilter(
        (root, args, { injector }) =>
          injector.get(PubSub).asyncIterator('messageAdded'),
        async (
          { messageAdded }: { messageAdded: Message },
          args,
          { currentUser, injector }
        ) => {
          if (!currentUser) return false;

          return injector.get(Chats).isParticipant({
            chatId: messageAdded.chat_id,
            userId: currentUser.id,
          });
        }
      ),
    },

    chatAdded: {
      subscribe: withFilter(
        (root, args, { injector }) =>
          injector.get(PubSub).asyncIterator('chatAdded'),
        async (
          { chatAdded }: { chatAdded: Chat },
          args,
          { currentUser, injector }
        ) => {
          if (!currentUser) return false;

          return injector.get(Chats).isParticipant({
            chatId: chatAdded.id,
            userId: currentUser.id,
          });
        }
      ),
    },

    chatRemoved: {
      subscribe: withFilter(
        (root, args, { injector }) =>
          injector.get(PubSub).asyncIterator('chatRemoved'),
        async (
          { targetChat }: { targetChat: Chat },
          args,
          { currentUser, injector }
        ) => {
          if (!currentUser) return false;

          return injector.get(Chats).isParticipant({
            chatId: targetChat.id,
            userId: currentUser.id,
          });
        }
      ),
    },
  },
};

export default new GraphQLModule({
  name: 'chats',
  typeDefs,
  resolvers,
  imports: () => [commonModule, usersModule],
  providers: () => [UnsplashApi, Chats],
});