const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

module.exports = {
  // Global Owner ID (controls all bots in all servers)
  ownerId: ['1048900823314354197','1367435143794524240', '1382630272725553193'],

  // Bot 11-20 Admin User IDs (controls bots 11-20 globally)
  bots11to20Admins: [
    '1309948486711509017',
    '1414254281208365187',
    '720656479241240616'
  ],
  bots1to10Admins: [
    '720656479241240616'
  ],

  // Server-specific Admin User IDs for bots 11-20
  // Format: { 'guildId': ['userId1', 'userId2'] }
  serverSpecificAdmins: {
    '1292783081811349525': ['1026483043743055932']
  },

  bots: [
    {
      token: process.env.BOT_TOKEN_1,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_2,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_3,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_4,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_5,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_6,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_7,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_8,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_9,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_10,
      guildId: '1242075132261040260',
      channelId: '1518597178883575809'
    },
    {
      token: process.env.BOT_TOKEN_11,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_12,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_13,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_14,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_15,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_16,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_17,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_18,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_19,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_20,
      guildId: '1292783081811349525',
      channelId: '1532017782042919054'
    },
    {
      token: process.env.BOT_TOKEN_21,
      guildId: '1195253356705361931',
      channelId: '1518817210276249722'
    },
    {
      token: process.env.BOT_TOKEN_22,
      guildId: '1195253356705361931',
      channelId: '1518817210276249722'
    },
    {
      token: process.env.BOT_TOKEN_23,
      guildId: '1195253356705361931',
      channelId: '1518817210276249722'
    },
    {
      token: process.env.BOT_TOKEN_24,
      guildId: '1521227404335513610',
      channelId: '1521227406319292483'
    },
      
      {
          token: process.env.BOT_TOKEN_25,
          guildId: '1378208063298867271',
          channelId: '1415978780823912499',
          nickname: null, // e.g. 'Bot 25'
          avatarPath: null, // e.g. 'assets/bot-25-avatar.png'
          bannerPath: null // e.g. 'assets/bot-25-banner.png'
      },
      {
          token: process.env.BOT_TOKEN_26,
          guildId: '1378208063298867271',
          channelId: '1415978780823912499',
          nickname: null,
          avatarPath: null,
          bannerPath: null
      },
      {
          token: process.env.BOT_TOKEN_27,
          guildId: '1378208063298867271',
          channelId: '1415978780823912499',
          nickname: null,
          avatarPath: null,
          bannerPath: null
      },
      {
          token: process.env.BOT_TOKEN_28,
          guildId: '1378208063298867271',
          channelId: '1415978780823912499',
          nickname: null,
          avatarPath: null,
          bannerPath: null
      },
      {
          token: process.env.BOT_TOKEN_29,
          guildId: '1378208063298867271',
          channelId: '1415978780823912499',
          nickname: null,
          avatarPath: null,
          bannerPath: null
      },
      {
          token: process.env.BOT_TOKEN_30,
          guildId: '1378208063298867271',
          channelId: '1415978780823912499',
          nickname: null,
          avatarPath: null,
          bannerPath: null
      }
  ],

  lavalink: {
    host: process.env.LAVALINK_HOST || 'jobs.hidencloud.com',
    port: parseInt(process.env.LAVALINK_PORT || '24704', 10),
    password: process.env.LAVALINK_PASSWORD || 'nerdxlive',
    secure: process.env.LAVALINK_SECURE === 'true'
  }
};
