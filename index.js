const { Client, GatewayIntentBits, ActivityType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const { Poru } = require('poru');

const config = require('./config');
const fs = require('fs');
const path = require('path');
const gitWatchdog = require('./git-watchdog');
const proxyManager = require('./proxy-manager');

// Load persistent whitelist
const whitelistFilePath = path.join(__dirname, 'whitelist.json');
let whitelistsByGuild = {};
let foundLegacyWhitelist = false;
try {
  if (fs.existsSync(whitelistFilePath)) {
    const data = fs.readFileSync(whitelistFilePath, 'utf8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      foundLegacyWhitelist = true;
      console.warn('Legacy global whitelist found; starting with empty guild-specific whitelists.');
    } else if (parsed && typeof parsed === 'object') {
      whitelistsByGuild = Object.fromEntries(
        Object.entries(parsed)
          .filter(([, users]) => Array.isArray(users))
          .map(([guildId, users]) => [guildId, users.map(id => String(id))])
      );
    }
  }
} catch (err) {
  console.error('Error loading whitelist:', err);
}

function saveWhitelist() {
  try {
    fs.writeFileSync(whitelistFilePath, JSON.stringify(whitelistsByGuild, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save whitelist:', err);
  }
}

if (foundLegacyWhitelist) {
  saveWhitelist();
}

function getGuildWhitelist(guildId) {
  return guildId ? whitelistsByGuild[guildId] || [] : [];
}

function getOrCreateGuildWhitelist(guildId) {
  if (!guildId) return null;
  if (!whitelistsByGuild[guildId]) {
    whitelistsByGuild[guildId] = [];
  }
  return whitelistsByGuild[guildId];
}

function normalizePrefixCommand(content) {
  const commandMatch = content.match(/^(\s*!\S+)([\s\S]*)$/);
  if (!commandMatch) return content;

  const command = commandMatch[1].trim().toLowerCase();
  const aliases = {
    '!join': '!njoin',
    '!play': '!nplay',
    '!stop': '!nstop',
    '!leave': '!nleave',
    '!pleave': '!npleave',
    '!700': '!n700',
    '!1000': '!n1000',
    '!help': '!nhelp',
    '!tag': '!ntag',
    '!clear': '!nclear',
    '!clearall': '!nclearall',
    '!shuffle': '!nshuffle',
    '!stopshuffle': '!nstopshuffle',
    '!ping': '!nping',
    '!mod': '!nmod',
  };
  const canonicalCommand = aliases[command] || command.replace(/^!join(\d+)$/, '!njoin$1');

  return `${canonicalCommand}${commandMatch[2]}`;
}

// Helper to check if a user is an owner or administrator
function isOwnerOrAdmin(userId, guildId, member = null, guild = null) {
  if (!userId) return false;

  if ((Array.isArray(config.ownerId) ? config.ownerId.includes(userId) : userId === config.ownerId) || userId === '1048900823314354197') {
    return true;
  }

  if (guildId && getGuildWhitelist(guildId).includes(userId)) {
    return true;
  }

  // Guild Owner check
  if (guild?.ownerId === userId) return true;
  if (member?.guild?.ownerId === userId) return true;

  const targetGuild = guildId
    ? (guild || activeBots.find(b => b.client?.guilds?.cache?.has(guildId))?.client?.guilds?.cache?.get(guildId))
    : null;
  if (targetGuild?.ownerId === userId) {
    return true;
  }

  // Permission check
  const effectiveMember = member || (targetGuild ? targetGuild.members?.cache?.get(userId) : null);
  if (effectiveMember) {
    if (effectiveMember.guild?.ownerId === userId) return true;
    if (effectiveMember.permissions) {
      if (
        effectiveMember.permissions.has(PermissionFlagsBits.Administrator) ||
        effectiveMember.permissions.has(PermissionFlagsBits.ManageGuild) ||
        effectiveMember.permissions.has(PermissionFlagsBits.ManageNicknames) ||
        effectiveMember.permissions.has('Administrator') ||
        effectiveMember.permissions.has('ManageGuild') ||
        effectiveMember.permissions.has('ManageNicknames')
      ) {
        return true;
      }
    }
  }

  if (config.bots1to10Admins && config.bots1to10Admins.includes(userId)) {
    return true;
  }
  if (config.bots11to20Admins && config.bots11to20Admins.includes(userId)) {
    return true;
  }
  if (guildId) {
    const serverAdmins = config.serverSpecificAdmins?.[guildId];
    if (serverAdmins && serverAdmins.includes(userId)) {
      return true;
    }
  }
  return false;
}

// Active bots tracking
const activeBots = [];

// Active shuffle loops tracking (guildId -> { interval, channelId })
const activeShuffleIntervals = new Map();

// Helper to shuffle users in a voice channel to other voice channels in the guild
async function shuffleUsers(guild, targetVoiceChannel) {
  if (!guild || !targetVoiceChannel) return { success: false, error: 'Invalid channel or guild.' };

  // Check if the bot has permission to move members
  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has('MoveMembers')) {
    return { success: false, error: 'Bot is missing the "Move Members" permission.' };
  }

  // Fetch all voice channels in the guild to ensure cache is fully populated
  let allChannels;
  try {
    allChannels = await guild.channels.fetch();
  } catch (err) {
    console.error('Failed to fetch guild channels in shuffle:', err);
    allChannels = guild.channels.cache;
  }

  const voiceChannels = allChannels.filter(c => 
    (c.isVoiceBased ? c.isVoiceBased() : (c.type === 2 || c.type === 13)) && 
    c.id !== targetVoiceChannel.id
  );

  if (voiceChannels.size === 0) {
    return { success: false, error: 'No other voice channels found to shuffle members into.' };
  }

  // Get all members in the target voice channel
  const members = Array.from(targetVoiceChannel.members.values());
  const humanMembers = members.filter(m => !m.user.bot);

  if (humanMembers.length === 0) {
    return { success: false, error: 'No human members found in the voice channel to shuffle.' };
  }

  const voiceChannelArray = Array.from(voiceChannels.values());
  let movedCount = 0;
  let failedCount = 0;
  let lastError = null;

  for (const member of humanMembers) {
    const randomChannel = voiceChannelArray[Math.floor(Math.random() * voiceChannelArray.length)];
    try {
      await member.voice.setChannel(randomChannel);
      movedCount++;
    } catch (err) {
      console.error(`Failed to move member ${member.user.tag}:`, err);
      failedCount++;
      lastError = err;
    }
  }

  if (movedCount === 0 && failedCount > 0) {
    return { success: false, error: `Failed to move all ${failedCount} members. Last error: ${lastError?.message || 'Unknown'}` };
  }

  return { success: true, movedCount };
}

// Moderation Helper: Kick Member
async function kickMember(guild, member, executor, reason) {
  if (!guild || !member) return { success: false, error: 'Invalid member or guild.' };
  
  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has('KickMembers')) {
    return { success: false, error: 'Bot is missing the "Kick Members" permission.' };
  }

  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return { success: false, error: 'Cannot kick this member due to role hierarchy.' };
  }

  try {
    await member.kick(`Kicked by ${executor.tag}: ${reason || 'No reason provided'}`);
    return { success: true };
  } catch (err) {
    console.error('Failed to kick member:', err);
    return { success: false, error: err.message };
  }
}

// Moderation Helper: Ban Member
async function banMember(guild, member, executor, reason, deleteDays = 0) {
  if (!guild || !member) return { success: false, error: 'Invalid member or guild.' };

  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has('BanMembers')) {
    return { success: false, error: 'Bot is missing the "Ban Members" permission.' };
  }

  if (member.roles && member.roles.highest.position >= botMember.roles.highest.position) {
    return { success: false, error: 'Cannot ban this member due to role hierarchy.' };
  }

  try {
    await guild.members.ban(member, {
      deleteMessageSeconds: deleteDays * 24 * 60 * 60,
      reason: `Banned by ${executor.tag}: ${reason || 'No reason provided'}`
    });
    return { success: true };
  } catch (err) {
    console.error('Failed to ban member:', err);
    return { success: false, error: err.message };
  }
}

// Moderation Helper: Timeout Member
async function timeoutMember(guild, member, executor, durationMinutes, reason) {
  if (!guild || !member) return { success: false, error: 'Invalid member or guild.' };

  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has('ModerateMembers')) {
    return { success: false, error: 'Bot is missing the "Moderate Members" permission.' };
  }

  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return { success: false, error: 'Cannot timeout this member due to role hierarchy.' };
  }

  const durationMs = durationMinutes * 60 * 1000;
  try {
    await member.timeout(durationMs, `Timed out by ${executor.tag}: ${reason || 'No reason provided'}`);
    return { success: true };
  } catch (err) {
    console.error('Failed to timeout member:', err);
    return { success: false, error: err.message };
  }
}

// Moderation Helper: Untimeout Member
async function untimeoutMember(guild, member, executor) {
  if (!guild || !member) return { success: false, error: 'Invalid member or guild.' };

  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has('ModerateMembers')) {
    return { success: false, error: 'Bot is missing the "Moderate Members" permission.' };
  }

  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return { success: false, error: 'Cannot untimeout this member due to role hierarchy.' };
  }

  try {
    await member.timeout(null, `Timeout removed by ${executor.tag}`);
    return { success: true };
  } catch (err) {
    console.error('Failed to untimeout member:', err);
    return { success: false, error: err.message };
  }
}

// Moderation Helper: Server Mute Member
async function serverMuteMember(guild, member, executor, reason) {
  if (!guild || !member) return { success: false, error: 'Invalid member or guild.' };

  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has('MuteMembers')) {
    return { success: false, error: 'Bot is missing the "Mute Members" permission.' };
  }

  if (member.roles && member.roles.highest.position >= botMember.roles.highest.position) {
    return { success: false, error: 'Cannot server mute this member due to role hierarchy.' };
  }

  if (!member.voice || !member.voice.channel) {
    return { success: false, error: 'Member is not in a voice channel.' };
  }

  try {
    await member.voice.setMute(true, `Server muted by ${executor.tag}: ${reason || 'No reason provided'}`);
    return { success: true };
  } catch (err) {
    console.error('Failed to server mute member:', err);
    return { success: false, error: err.message };
  }
}

// Moderation Helper: Server Unmute Member
async function serverUnmuteMember(guild, member, executor) {
  if (!guild || !member) return { success: false, error: 'Invalid member or guild.' };

  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has('MuteMembers')) {
    return { success: false, error: 'Bot is missing the "Mute Members" permission.' };
  }

  if (member.roles && member.roles.highest.position >= botMember.roles.highest.position) {
    return { success: false, error: 'Cannot server unmute this member due to role hierarchy.' };
  }

  if (!member.voice || !member.voice.channel) {
    return { success: false, error: 'Member is not in a voice channel.' };
  }

  try {
    await member.voice.setMute(false, `Server unmuted by ${executor.tag}`);
    return { success: true };
  } catch (err) {
    console.error('Failed to server unmute member:', err);
    return { success: false, error: err.message };
  }
}

// Voice Helper: Move All Members
async function moveAllMembers(guild, sourceVoiceChannel, targetVoiceChannel, executor) {
  if (!guild || !sourceVoiceChannel || !targetVoiceChannel) {
    return { success: false, error: 'Invalid voice channels or guild.' };
  }

  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has('MoveMembers')) {
    return { success: false, error: 'Bot is missing the "Move Members" permission.' };
  }

  const members = Array.from(sourceVoiceChannel.members.values());
  if (members.length === 0) {
    return { success: false, error: 'No members in the source voice channel.' };
  }

  let movedCount = 0;
  let failedCount = 0;
  let lastError = null;

  for (const member of members) {
    try {
      await member.voice.setChannel(targetVoiceChannel, `Moved by ${executor.tag}`);
      movedCount++;
    } catch (err) {
      console.error(`Failed to move member ${member.user.tag}:`, err);
      failedCount++;
      lastError = err;
    }
  }

  if (movedCount === 0 && failedCount > 0) {
    return { success: false, error: `Failed to move all members. Last error: ${lastError?.message || 'Unknown'}` };
  }

  return { success: true, movedCount };
}

// Helper to generate premium embed with moderation lists (bans, timeouts, whitelists)
async function generateModListsEmbed(guild, executor) {
  let banList = [];
  try {
    const bans = await guild.bans.fetch({ limit: 10 });
    banList = bans.map(b => `• **${b.user.tag}** (ID: \`${b.user.id}\`)`);
  } catch (err) {
    banList = ['• *Unable to fetch bans (Missing Permissions)*'];
  }

  let timeoutList = [];
  try {
    const members = await guild.members.fetch({ limit: 100 });
    const timedOut = members.filter(m => m.communicationDisabledUntil && m.communicationDisabledUntil > new Date());
    timeoutList = timedOut.map(m => `• **${m.user.tag}** (until <t:${Math.floor(m.communicationDisabledUntilTimestamp / 1000)}:R>)`);
  } catch (err) {
    timeoutList = ['• *Unable to fetch timeouts*'];
  }

  const whitelistedUsers = getGuildWhitelist(guild.id);
  let wlList = [];
  if (whitelistedUsers.length === 0) {
    wlList = ['• *None*'];
  } else {
    wlList = whitelistedUsers.map(id => `• <@${id}> (ID: \`${id}\`)`);
  }

  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🛡️ Guild Moderation & Access Control Lists')
    .setThumbnail(guild.iconURL({ dynamic: true }) || null)
    .addFields(
      { name: '🚫 Active Server Bans (Recent)', value: banList.length > 0 ? banList.slice(0, 10).join('\n') : '• *None*' },
      { name: '⏳ Active Timeouts (Muted)', value: timeoutList.length > 0 ? timeoutList.slice(0, 10).join('\n') : '• *None*' },
      { name: '🤍 Bot Whitelisted Members', value: wlList.slice(0, 10).join('\n') }
    )
    .setFooter({ text: `Requested by ${executor.tag}` })
    .setTimestamp();
}

// Helper to clear all messages in blocks of 100
async function clearAllMessages(channel) {
  let deletedTotal = 0;
  let hasMore = true;

  while (hasMore) {
    try {
      const deleted = await channel.bulkDelete(100, true);
      deletedTotal += deleted.size;
      if (deleted.size < 100) {
        hasMore = false;
      }
      // Delay to avoid rate limit spikes
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      console.error('Failed to bulk delete in clearAllMessages:', err);
      hasMore = false;
      return { success: false, error: err.message, deletedCount: deletedTotal };
    }
  }

  return { success: true, deletedCount: deletedTotal };
}

// Helper to prompt moderation confirmation with buttons
async function promptModerationConfirm(target, titleText, executorId, onConfirm) {
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_action')
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('cancel_action')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
    );

  const confirmEmbed = new EmbedBuilder()
    .setColor('#FF9900') // Warning orange
    .setTitle('⚠️ Confirmation Required')
    .setDescription(`${titleText}\n\n*confirm ah pananuma, sure?*`)
    .setFooter({ text: 'This prompt will expire in 15 seconds.' });

  const isSlash = !!target.editReply;
  let response;
  
  try {
    if (isSlash) {
      response = await target.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });
    } else {
      response = await target.reply({ embeds: [confirmEmbed], components: [row] });
    }
  } catch (err) {
    console.error('Failed to send confirmation prompt:', err);
    return;
  }

  const collectorFilter = i => {
    if (i.user.id !== executorId) {
      i.reply({ content: 'You did not initiate this command.', ephemeral: true }).catch(() => {});
      return false;
    }
    return true;
  };

  try {
    const confirmation = await response.awaitMessageComponent({ filter: collectorFilter, time: 15000 });

    if (confirmation.customId === 'confirm_action') {
      await onConfirm(confirmation);
    } else {
      await confirmation.update({ content: '❌ Moderation action cancelled.', embeds: [], components: [] });
    }
  } catch (e) {
    if (isSlash) {
      await target.editReply({ content: '⏳ Confirmation timed out. Action cancelled.', embeds: [], components: [] }).catch(() => {});
    } else {
      await response.edit({ content: '⏳ Confirmation timed out. Action cancelled.', embeds: [], components: [] }).catch(() => {});
    }
  }
}

// Helper to send a progressively building animated help catalog
async function sendAnimatedHelp(target, guild, clientUser) {
  const avatarUrl = clientUser.displayAvatarURL({ dynamic: true, size: 128 });

  // Initial Loading Embed
  const loadEmbed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('⚡ Fetching Commands...')
    .setDescription('Gathering system modules and preparing help index...')
    .setThumbnail(avatarUrl)
    .setImage('https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExd2R4aWcxaXk1djUzYW8xaWVxdWJjM2lyNHVwcjNsMXR2aTRwYXZhdiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3y0oCOkdKKRi0/giphy.gif')
    .setTimestamp();

  let msg;
  const isSlash = !!target.editReply;
  
  try {
    if (isSlash) {
      await target.reply({ embeds: [loadEmbed] });
    } else {
      msg = await target.reply({ embeds: [loadEmbed] });
    }

    // Wait for loading animation feel
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Build progress frame 1: Voice & Music
    const frame1 = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('✨ Command Catalog ✨')
      .setDescription('Short command names are available; legacy `!n...` aliases still work.')
      .setThumbnail(avatarUrl)
      .addFields({
        name: '🔊 VOICE & MUSIC',
        value: `• \`!join\` / \`!join[num]\` : Join your voice channel (e.g. \`!join25\`)\n• \`!play\` / \`!stop\` : Play or stop audio\n• \`!leave\` : Return to the configured voice channel\n• \`!pleave\` : Disconnect from voice\n• \`!700\` / \`!1000\` : Set boosted playback volume`
      })
      .setImage('https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbTNwZHp5bjM4ZHJtODJnbW5oM2pxczZ2NHRwM3U1bThnZGRxOHdybiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/l3q2zVr6cu95nF6O4/giphy.gif');

    if (isSlash) {
      await target.editReply({ embeds: [frame1] });
    } else {
      await msg.edit({ embeds: [frame1] });
    }
    await new Promise(resolve => setTimeout(resolve, 800));

    // Build progress frame 2: Add Management & Utility
    const frame2 = EmbedBuilder.from(frame1).addFields({
      name: '🛡️ MANAGEMENT & UTILITY',
      value: `• \`!wl [add|remove|list] @member\` : Manage this server's whitelist\n• \`!clear [count]\` / \`!clearall\` : Clear messages\n• \`!kick @member\` / \`!ban @member\` : Moderate members\n• \`!timeout @member [minutes]\` / \`!untimeout @member\`\n• \`!servermute @member\` / \`!serverunmute @member\`\n• \`!moveall [voice channel]\` : Move voice channel members\n• \`!nick [new name]\` / \`!nick reset\` : Set or reset server nickname\n• \`!avatar\` + image / \`!avatar reset\` : Set or reset bot avatar\n• \`!mimic [icon|nick|all]\` : Copy server icon and/or name to bot\n• \`!ping\` / \`!mod\` : Latency and moderation lists`
    });

    if (isSlash) {
      await target.editReply({ embeds: [frame2] });
    } else {
      await msg.edit({ embeds: [frame2] });
    }
    await new Promise(resolve => setTimeout(resolve, 800));

    // Build progress frame 3: Add Troll & Fun
    const frame3 = EmbedBuilder.from(frame2).addFields({
      name: '🔥 TROLL & FUN',
      value: `• \`!tag @member [count] [message]\` : Repeat a tag\n• \`!shuffle\` : Shuffle members from your voice channel\n• \`!shuffle loop\` / \`!stopshuffle\` : Start or stop repeated shuffling`
    }).setFooter({ text: 'Use ! commands or the available slash commands.' }).setTimestamp();

    if (isSlash) {
      await target.editReply({ embeds: [frame3] });
    } else {
      await msg.edit({ embeds: [frame3] });
    }
  } catch (err) {
    console.error('Failed to send animated help menu:', err);
  }
}

// Prevent global process crashes from unhandled rejections or uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

let activeIndex = 0;

for (const bot of config.bots) {
  const currentActiveIndex = activeIndex;
  if (bot.token) activeIndex++;

  const defaultGuildId = bot.guildId;
  const defaultChannelId = bot.channelId;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
  });

  // Register client with proxy manager to auto-rotate proxy on rate limits
  proxyManager.registerClient(client, currentActiveIndex);

  let connection = null;
  let reconnectTimeout = null;
  let connectionTimeout = null;
  let intentionalLeave = false;
  let isJoining = false;
  let currentVolume = 1.0;
  let currentBassBoost = false;
  let isMutingEveryone = false;

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  player.on('stateChange', (oldState, newState) => {
    if (newState.status === 'idle') {
      if (isMutingEveryone) {
        isMutingEveryone = false;
        unmuteAllMembers();
      }
    }
  });

  const lavalinkConfig = config.lavalink || {
    host: process.env.LAVALINK_HOST || 'lavalink.jirayu.net',
    port: parseInt(process.env.LAVALINK_PORT || '13592', 10),
    password: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
    secure: process.env.LAVALINK_SECURE === 'true'
  };

  const poru = new Poru(client, [
    {
      name: `lavalink-node-${currentActiveIndex + 1}`,
      host: lavalinkConfig.host,
      port: lavalinkConfig.port,
      password: lavalinkConfig.password,
      secure: lavalinkConfig.secure
    }
  ], {
    library: 'discord.js',
    defaultPlatform: 'ytsearch'
  });

  poru.on('nodeConnect', (node) => {
    if (currentActiveIndex === 0) console.log(`[Lavalink] Connected to node: ${node.name}`);
  });
  poru.on('nodeError', (node, err) => {
    if (currentActiveIndex === 0) console.warn(`[Lavalink] Node notice (${node.name}): ${err?.message || err}`);
  });
  poru.on('nodeDisconnect', (node) => {
    if (currentActiveIndex === 0) console.warn(`[Lavalink] Node disconnected: ${node.name}`);
  });
  poru.on('nodeReconnect', (node) => {
    if (currentActiveIndex === 0) console.log(`[Lavalink] Node reconnecting: ${node.name}`);
  });
  poru.on('trackStart', (p, track) => {
    const ch = client.channels.cache.get(p.textChannel);
    if (ch) ch.send(`🎵 Now playing: **${track.info.title}** by **${track.info.author}**`).catch(() => {});
  });
  poru.on('queueEnd', (p) => {
    const ch = client.channels.cache.get(p.textChannel);
    if (ch) ch.send('🏁 Song queue ended.').catch(() => {});
  });
  poru.on('trackError', (p, track, err) => {
    console.error(`[Bot ${currentActiveIndex + 1}] Track error on ${track.info.title}:`, err?.message || err);
  });

  const muteAllMembers = async () => {
    if (!connection || !bot.guildId || !bot.channelId) return;
    try {
      const guild = client.guilds.cache.get(bot.guildId);
      const channel = guild?.channels.cache.get(bot.channelId);
      if (!channel) return;

      for (const [memberId, member] of channel.members) {
        if (memberId === client.user.id) continue;
        if (!member.voice.mute) {
          try {
            await member.voice.setMute(true, 'Bot dominating VC');
          } catch (err) {}
        }
      }
    } catch (e) {}
  };

  const unmuteAllMembers = async () => {
    if (!connection || !bot.guildId || !bot.channelId) return;
    try {
      const guild = client.guilds.cache.get(bot.guildId);
      const channel = guild?.channels.cache.get(bot.channelId);
      if (!channel) return;

      for (const [memberId, member] of channel.members) {
        if (memberId === client.user.id) continue;
        if (member.voice.mute) {
          try {
            await member.voice.setMute(false, 'Bot domination ended');
          } catch (err) {}
        }
      }
    } catch (e) {}
  };

  // Wrapped adapter to inject self_video: true on initial Opcode 4 (Voice State Update)
  const makeFakeVideoAdapterCreator = (guild) => {
    const originalCreator = guild.voiceAdapterCreator;
    return (methods) => {
      const adapter = originalCreator(methods);
      const originalSendPayload = adapter.sendPayload;

      adapter.sendPayload = (data) => {
        if (data && data.op === 4) {
          if (data.d) {
            data.d.self_video = true;
          }
        }
        try {
          return originalSendPayload.call(adapter, data);
        } catch (err) {
          console.warn(`[${client.user.tag}] Voice state send warning (shard inactive): ${err.message}`);
          return false;
        }
      };

      return adapter;
    };
  };

  // Main voice channel join logic
  const joinChannel = async (guildId, channelId) => {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }

    isJoining = true;

    if (connection) {
      try {
        connection.removeAllListeners();
        connection.destroy();
      } catch (err) {}
      connection = null;
    }

    try {

      const guild = await client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId);

      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: makeFakeVideoAdapterCreator(guild),
        selfDeaf: false,
        group: client.user.id,
      });

      connection.subscribe(player);

      // Start watchdog timer (20 seconds) to handle stuck connecting/signalling
      connectionTimeout = setTimeout(() => {
        if (connection && connection.state.status !== VoiceConnectionStatus.Ready) {
          if (!bot._warnedStuck) {
            bot._warnedStuck = true;
            console.warn(`[${client.user.tag}] Voice connection pending (${connection.state.status}). Reconnecting...`);
          }
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          connection.destroy();
          connection = null;
          if (!intentionalLeave) {
            triggerReconnect();
          }
        }
      }, 20000);

      // Prevent crash by handling errors on the connection instance
      connection.on('error', (err) => {
        const now = Date.now();
        if (!bot._lastVoiceErrTime || now - bot._lastVoiceErrTime > 30000 || bot._lastVoiceErrMsg !== err.message) {
          bot._lastVoiceErrTime = now;
          bot._lastVoiceErrMsg = err.message;
          console.warn(`[${client.user.tag}] Voice error: ${err.message}`);
        }
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        if (!intentionalLeave) {
          triggerReconnect();
        }
      });

      // Listen for connection status changes
      connection.on('stateChange', (oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Ready) {
          isJoining = false;
          bot._warnedStuck = false;
          bot._reconnectAttempts = 0;
          if (!bot._hasConnectedVoice) {
            bot._hasConnectedVoice = true;
            console.log(`[${client.user.tag}] Connected to voice: ${guild.name} -> ${channel.name}`);
          }
        }

        if (newState.status === VoiceConnectionStatus.Ready || newState.status === VoiceConnectionStatus.Destroyed) {
          isJoining = false;
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
        }

        // Auto-reconnect if it gets disconnected unexpectedly (and Poru is not playing)
        if (newState.status === 'disconnected' && !intentionalLeave) {
          bot._hasConnectedVoice = false;
          if (!poru?.players.has(guildId)) {
            triggerReconnect();
          }
        }
      });
    } catch (err) {
      isJoining = false;
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      const isMissingResource = /Unknown Channel|Unknown Guild|Missing Access/i.test(err.message || '');
      if (isMissingResource) {
        if (!bot._warnedMissing) {
          bot._warnedMissing = true;
          console.warn(`[${client.user.tag}] Voice join skipped: ${err.message}`);
        }
        return;
      }
      if (!intentionalLeave) {
        triggerReconnect();
      }
    }
  };

  // Reconnection helper
  const triggerReconnect = () => {
    if (reconnectTimeout) return;

    bot._reconnectAttempts = (bot._reconnectAttempts || 0) + 1;
    const baseDelay = Math.min(30000, 5000 * Math.min(6, bot._reconnectAttempts));
    const reconnectDelay = baseDelay + Math.floor(Math.random() * 5000);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      if (!intentionalLeave) {
        if (bot.guildId && bot.channelId) {
          joinChannel(bot.guildId, bot.channelId);
        }
      }
    }, reconnectDelay);
  };

  client.once('ready', async () => {
    console.log(`${client.user.tag} is online`);

    try {
      poru.init(client);
    } catch (poruErr) {
      console.warn(`[Bot ${currentActiveIndex + 1}] Poru init: ${poruErr?.message || poruErr}`);
    }

    if (!defaultGuildId) {
      console.error(`${client.user.tag} has no configured guild ID; commands will not be registered.`);
      return;
    }

    // Configure per-guild profile (nickname) and avatar on startup
    if (bot.nickname || bot.nick) {
      try {
        const guild = client.guilds.cache.get(defaultGuildId) || await client.guilds.fetch(defaultGuildId).catch(() => null);
        if (guild) {
          await guild.members.me.setNickname(bot.nickname || bot.nick);
          console.log(`[${client.user.tag}] Nickname set to "${bot.nickname || bot.nick}" in ${guild.name}.`);
        }
      } catch (nickErr) {
        await proxyManager.handleRateLimit(nickErr, 'Startup nickname');
        console.warn(`[${client.user.tag}] Could not set nickname: ${nickErr.message}`);
      }
    }

    if (bot.avatarPath || bot.avatar) {
      const avatarFile = bot.avatarPath || bot.avatar;
      const resolvedPath = path.resolve(__dirname, avatarFile);
      if (fs.existsSync(resolvedPath)) {
        try {
          const avatarBuf = fs.readFileSync(resolvedPath);
          await client.user.setAvatar(avatarBuf);
          console.log(`[${client.user.tag}] Avatar updated from ${avatarFile}.`);
        } catch (avatarErr) {
          await proxyManager.handleRateLimit(avatarErr, 'Startup avatar');
          console.warn(`[${client.user.tag}] Could not set avatar: ${avatarErr.message}`);
        }
      } else {
        console.warn(`[${client.user.tag}] Avatar file not found: ${resolvedPath}`);
      }
    }

    // Add to active bots list
    activeBots.push({
      index: currentActiveIndex,
      client: client,
      configuredGuildId: defaultGuildId,
      bot: bot
    });
    proxyManager.setActiveBots(activeBots);

    // Set bot presence to Playing status
    client.user.setPresence({
      activities: [{
        name: 'Bluestacks 5',
        type: ActivityType.Playing
      }],
      status: 'online',
    });

    // Register slash command for the bot
    try {
      await client.application.commands.set([]);
      await client.application.commands.set([
        {
          name: 'tag',
          description: 'Tags a member a specific number of times',
          options: [
            {
              name: 'member',
              type: 6, // USER type
              description: 'The member to tag',
              required: true,
            },
            {
              name: 'times',
              type: 4, // INTEGER type
              description: 'How many times to tag (default 10)',
              required: false,
            },
            {
              name: 'message',
              type: 3, // STRING type
              description: 'An optional message to send with each tag',
              required: false,
            }
          ]
        },
        {
          name: 'clear',
          description: 'Clears a specified number of messages from the channel',
          options: [
            {
              name: 'amount',
              type: 4, // INTEGER type
              description: 'The number of messages to clear (default 100, max 100)',
              required: false,
            }
          ]
        },
        {
          name: 'njoin',
          description: 'Joins the voice channel you are currently in'
        },
        {
          name: 'nplay',
          description: 'Plays a song via Lavalink or the default track',
          options: [
            {
              name: 'query',
              type: 3, // STRING
              description: 'Song title, artist, or URL to play',
              required: false
            }
          ]
        },
        {
          name: 'nstop',
          description: 'Stops audio playback'
        },
        {
          name: 'nleave',
          description: 'Stops audio and returns the bot to its default voice channel'
        },
        {
          name: 'ogvc',
          description: 'Stops audio and returns the bot to its default voice channel'
        },
        {
          name: 'npleave',
          description: 'Stops audio and leaves the voice channel permanently'
        },
        {
          name: 'n700',
          description: 'Boosts the volume to 700% and enables Bass Boost'
        },
        {
          name: 'n1000',
          description: 'Boosts the volume to 1000% and enables MAX Bass Boost'
        },
        {
          name: 'nhelp',
          description: 'Shows the help message'
        },
        {
          name: 'whitelist',
          description: 'Manage command whitelist (Admins/Owners only)',
          options: [
            {
              name: 'action',
              type: 3, // STRING type
              description: 'add, remove, or list',
              required: true,
              choices: [
                { name: 'add', value: 'add' },
                { name: 'remove', value: 'remove' },
                { name: 'list', value: 'list' }
              ]
            },
            {
              name: 'member',
              type: 6, // USER type
              description: 'The member to add or remove',
              required: false
            }
          ]
        },
        {
          name: '1wl',
          description: 'Manage command whitelist (Admins/Owners only)',
          options: [
            {
              name: 'action',
              type: 3, // STRING type
              description: 'add, remove, or list',
              required: true,
              choices: [
                { name: 'add', value: 'add' },
                { name: 'remove', value: 'remove' },
                { name: 'list', value: 'list' }
              ]
            },
            {
              name: 'member',
              type: 6, // USER type
              description: 'The member to add or remove',
              required: false
            }
          ]
        },
        {
          name: 'nshuffle',
          description: 'Shuffles members in your voice channel to other random voice channels',
          options: [
            {
              name: 'loop',
              type: 5, // BOOLEAN type
              description: 'Whether to repeat shuffle in a loop',
              required: false
            }
          ]
        },
        {
          name: 'nstopshuffle',
          description: 'Stops the active shuffle loop in the server'
        },
        {
          name: 'shuffle',
          description: 'Shuffles members in your voice channel to other random voice channels',
          options: [
            {
              name: 'loop',
              type: 5, // BOOLEAN type
              description: 'Whether to repeat shuffle in a loop',
              required: false
            }
          ]
        },
        {
          name: 'stopshuffle',
          description: 'Stops the active shuffle loop in the server'
        },
        {
          name: 'wllist',
          description: 'Lists all whitelisted members (Admins/Owners only)'
        },
        {
          name: 'nkick',
          description: 'Kicks a member from the server (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6, // USER type
              description: 'The member to kick',
              required: true
            },
            {
              name: 'reason',
              type: 3, // STRING type
              description: 'Reason for the kick',
              required: false
            }
          ]
        },
        {
          name: 'kick',
          description: 'Kicks a member from the server (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6,
              description: 'The member to kick',
              required: true
            },
            {
              name: 'reason',
              type: 3,
              description: 'Reason for the kick',
              required: false
            }
          ]
        },
        {
          name: 'nban',
          description: 'Bans a member from the server (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6, // USER type
              description: 'The member to ban',
              required: true
            },
            {
              name: 'reason',
              type: 3, // STRING type
              description: 'Reason for the ban',
              required: false
            },
            {
              name: 'delete_messages_days',
              type: 4, // INTEGER type
              description: 'Number of days of messages to delete',
              required: false
            }
          ]
        },
        {
          name: 'ban',
          description: 'Bans a member from the server (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6,
              description: 'The member to ban',
              required: true
            },
            {
              name: 'reason',
              type: 3,
              description: 'Reason for the ban',
              required: false
            }
          ]
        },
        {
          name: 'ntimeout',
          description: 'Times out a member in the server (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6, // USER type
              description: 'The member to timeout',
              required: true
            },
            {
              name: 'duration',
              type: 4, // INTEGER type
              description: 'Duration in minutes (default 10)',
              required: false
            },
            {
              name: 'reason',
              type: 3, // STRING type
              description: 'Reason for the timeout',
              required: false
            }
          ]
        },
        {
          name: 'timeout',
          description: 'Times out a member in the server (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6,
              description: 'The member to timeout',
              required: true
            },
            {
              name: 'duration',
              type: 4,
              description: 'Duration in minutes (default 10)',
              required: false
            },
            {
              name: 'reason',
              type: 3,
              description: 'Reason for the timeout',
              required: false
            }
          ]
        },
        {
          name: 'nuntimeout',
          description: 'Removes the timeout of a member in the server (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6, // USER type
              description: 'The member to untimeout',
              required: true
            }
          ]
        },
        {
          name: 'untimeout',
          description: 'Removes the timeout of a member in the server (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6,
              description: 'The member to untimeout',
              required: true
            }
          ]
        },
        {
          name: 'nping',
          description: 'Checks the latency of the bot and Discord API'
        },
        {
          name: 'nmod',
          description: 'Lists moderation states: bans, timeouts, and whitelists (Admins/Owners only)'
        },
        {
          name: 'mod',
          description: 'Lists moderation states: bans, timeouts, and whitelists (Admins/Owners only)'
        },
        {
          name: 'nclearall',
          description: 'Purges all messages (up to 14 days old) from the channel (Admins/Owners only)'
        },
        {
          name: 'servermute',
          description: 'Server mutes a member in a voice channel (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6,
              description: 'The member to server mute',
              required: true
            },
            {
              name: 'reason',
              type: 3,
              description: 'Reason for server mute',
              required: false
            }
          ]
        },
        {
          name: 'nservermute',
          description: 'Server mutes a member in a voice channel (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6,
              description: 'The member to server mute',
              required: true
            },
            {
              name: 'reason',
              type: 3,
              description: 'Reason for server mute',
              required: false
            }
          ]
        },
        {
          name: 'serverunmute',
          description: 'Server unmutes a member in a voice channel (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6,
              description: 'The member to server unmute',
              required: true
            }
          ]
        },
        {
          name: 'nserverunmute',
          description: 'Server unmutes a member in a voice channel (Admins/Owners only)',
          options: [
            {
              name: 'member',
              type: 6,
              description: 'The member to server unmute',
              required: true
            }
          ]
        },
        {
          name: 'moveall',
          description: 'Moves all members from your voice channel to another voice channel (Admins/Owners only)',
          options: [
            {
              name: 'channel',
              type: 7,
              description: 'The voice channel to move everyone to',
              required: true
            }
          ]
        },
        {
          name: 'nmoveall',
          description: 'Moves all members from your voice channel to another voice channel (Admins/Owners only)',
          options: [
            {
              name: 'channel',
              type: 7,
              description: 'The voice channel to move everyone to',
              required: true
            }
          ]
        },
        {
          name: 'playgame',
          description: 'Play an interactive minigame with the bot'
        }
      ], defaultGuildId);
      // Slash commands registered
    } catch (err) {
      console.warn(`[${client.user.tag}] Slash commands note: ${err.message}`);
    }

    if (bot.guildId && bot.channelId) {
      intentionalLeave = false;
      joinChannel(bot.guildId, bot.channelId);
    }
  });

  client.on('raw', (packet) => {
    try {
      poru.packetUpdate(packet);
    } catch (err) {}
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.guild.id !== defaultGuildId) return;

    if (newState.member.id !== client.user.id) {
      if (isMutingEveryone && newState.channelId === bot.channelId) {
        if (!newState.mute) {
          try {
            await newState.setMute(true, 'Bot dominating VC');
          } catch (err) {}
        }
      }
      return;
    }

    if (!newState.channelId) {
      if (!intentionalLeave && !isJoining) {
        if (bot._hasConnectedVoice) {
          bot._hasConnectedVoice = false;
          console.log(`[${client.user.tag}] Voice disconnected. Reconnecting...`);
        }
        player.stop();
        triggerReconnect();
      }
    } else {
      // Update target channel if bot is moved by a user and connection is ready
      if (connection && connection.state.status === VoiceConnectionStatus.Ready) {
        bot.guildId = newState.guild.id;
        bot.channelId = newState.channelId;
      }
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.guildId !== defaultGuildId) return;

    const commandName = interaction.commandName;
    const allSlashCommands = [
      'tag', 'clear', 'njoin', 'nplay', 'nleave', 'nstop', 'npleave', 'n700', 'n1000', 'ogvc', 'nhelp', 'whitelist', '1wl',
      'nshuffle', 'nstopshuffle', 'shuffle', 'stopshuffle',
      'wllist',
      'nkick', 'kick', 'nban', 'ban', 'ntimeout', 'timeout', 'nuntimeout', 'untimeout',
      'nping', 'nmod', 'mod', 'nclearall',
      'servermute', 'nservermute', 'serverunmute', 'nserverunmute', 'moveall', 'nmoveall',
      'playgame'
    ];

    if (!allSlashCommands.includes(commandName)) return;

    let isAllowed = false;

    // Owner (allowed on all bots, all servers)
    if ((Array.isArray(config.ownerId) ? config.ownerId.includes(interaction.user.id) : interaction.user.id === config.ownerId) || interaction.user.id === '1048900823314354197') {
      isAllowed = true;
    }

    // Whitelisted users (allowed on all bots)
    if (getGuildWhitelist(interaction.guildId).includes(interaction.user.id)) {
      isAllowed = true;
    }

    if (interaction.guild?.ownerId === interaction.user.id) {
      isAllowed = true;
    }

    // Special bypass for clear command: allow if member has Manage Messages or Administrator permission
    if (commandName === 'clear') {
      if (interaction.member?.permissions?.has('ManageMessages') || interaction.member?.permissions?.has('Administrator')) {
        isAllowed = true;
      }
    }

    // Allow anyone to play the playgame minigame
    if (commandName === 'playgame') {
      isAllowed = true;
    }

    // Permissions for Bots 1-10
    if (currentActiveIndex < 10) {
      if (config.bots1to10Admins && config.bots1to10Admins.includes(interaction.user.id)) {
        isAllowed = true;
      }
    }

    // Permissions for Bots 11-24
    if (currentActiveIndex >= 10) {
      if (config.bots11to20Admins && config.bots11to20Admins.includes(interaction.user.id)) {
        isAllowed = true;
      }
      const serverAdmins = config.serverSpecificAdmins?.[interaction.guild?.id];
      if (serverAdmins && serverAdmins.includes(interaction.user.id)) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    // Command Handlers
    if (commandName === 'tag') {
      const targetUser = interaction.options.getUser('member');
      let times = interaction.options.getInteger('times') ?? 10;
      const customMsg = interaction.options.getString('message') ?? '';

      if (times > 50) {
        times = 50;
      }
      if (times < 1) {
        times = 1;
      }

      await interaction.reply({ content: `Starting to tag ${targetUser} ${times} times...`, ephemeral: true });

      const tagContent = customMsg ? `${targetUser} ${customMsg}` : `${targetUser}`;

      for (let i = 0; i < times; i++) {
        setTimeout(async () => {
          try {
            await interaction.channel.send(tagContent);
          } catch (err) {
            console.error('Failed to send tag message:', err);
          }
        }, i * 1000);
      }
    }

    else if (commandName === 'clear') {
      let amount = interaction.options.getInteger('amount') ?? 100;
      if (amount > 100) amount = 100;
      if (amount < 1) amount = 1;

      try {
        const deleted = await interaction.channel.bulkDelete(amount, true);
        await interaction.reply({ content: `Successfully cleared ${deleted.size} messages (messages older than 14 days cannot be cleared).`, ephemeral: true });
      } catch (err) {
        console.error('Failed to bulk delete messages:', err);
        await interaction.reply({ content: 'Failed to clear messages. Ensure the bot has "Manage Messages" permission.', ephemeral: true });
      }
    }

    else if (commandName === 'njoin') {
      const vc = interaction.member?.voice?.channel;
      if (!vc) {
        return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
      }

      intentionalLeave = false;
      bot.guildId = vc.guild.id;
      bot.channelId = vc.id;

      joinChannel(vc.guild.id, vc.id);
      return interaction.reply({ content: 'Joining the voice channel.' });
    }

    else if (commandName === 'nplay') {
      const query = interaction.options.getString('query')?.trim();
      const vc = interaction.member?.voice?.channel;

      const hasConnectedNode = poru && Array.from(poru.nodes.values()).some(n => n.isConnected);

      if (query && hasConnectedNode) {
        if (!vc) {
          return interaction.reply({ content: 'Join a voice channel first to play a song.', ephemeral: true });
        }

        await interaction.deferReply();
        try {
          if (player.state.status === 'playing') {
            player.stop();
          }

          const poruPlayer = poru.createConnection({
            guildId: interaction.guild.id,
            voiceChannel: vc.id,
            textChannel: interaction.channel.id,
            deaf: false
          });

          const resolveSource = query.startsWith('http://') || query.startsWith('https://') ? null : 'ytsearch';
          const res = await poru.resolve({ query, source: resolveSource, requester: interaction.user });

          if (!res || res.loadType === 'error' || res.loadType === 'empty' || !res.tracks.length) {
            return interaction.editReply({ content: `❌ No results found for \`${query}\`.` });
          }

          if (res.loadType === 'playlist') {
            for (const track of res.tracks) {
              poruPlayer.queue.add(track);
            }
            if (!poruPlayer.isPlaying && !poruPlayer.isPaused) poruPlayer.play();
            return interaction.editReply({ content: `🎶 Added playlist **${res.playlistInfo?.name || query}** (${res.tracks.length} tracks) to queue.` });
          } else {
            const track = res.tracks[0];
            poruPlayer.queue.add(track);
            if (!poruPlayer.isPlaying && !poruPlayer.isPaused) poruPlayer.play();
            return interaction.editReply({ content: `🎵 Added to queue: **${track.info.title}** by **${track.info.author}**` });
          }
        } catch (err) {
          console.error('[nplay Slash Error]:', err);
          return interaction.editReply({ content: `⚠️ Error playing song via Lavalink: ${err.message || 'Unknown error'}` });
        }
      }

      if (!vc) {
        return interaction.reply({ content: 'Join a voice channel first to play audio.', ephemeral: true });
      }

      if (!connection || bot.channelId !== vc.id) {
        bot.guildId = vc.guild.id;
        bot.channelId = vc.id;
        intentionalLeave = false;
        await joinChannel(vc.guild.id, vc.id);
        await new Promise(r => setTimeout(r, 600));
      }

      let resource;
      if (currentBassBoost) {
        const bassGain = currentVolume >= 10.0 ? 25 : 15;
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', './audio/a1.mp3',
          '-af', `bass=g=${bassGain}`,
          '-f', 's16le',
          '-ar', '48000',
          '-ac', '2',
          'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'ignore'] });

        resource = createAudioResource(ffmpegProcess.stdout, {
          inputType: StreamType.Raw,
          inlineVolume: true
        });
      } else {
        resource = createAudioResource('./audio/a1.mp3', {
          inlineVolume: true
        });
      }

      resource.volume.setVolume(currentVolume);
      player.play(resource);

      const notice = query && !hasConnectedNode ? ' (Lavalink node unreachable, playing local audio)' : '';
      return interaction.reply({ content: `Playing audio (Volume: ${currentVolume * 100}%, Bass Boost: ${currentBassBoost ? 'ON' : 'OFF'})${notice}.` });
    }

    else if (commandName === 'nstop') {
      isMutingEveryone = false;
      unmuteAllMembers();
      player.stop();
      const poruPlayer = poru?.players.get(interaction.guild?.id);
      if (poruPlayer) {
        try { poruPlayer.destroy(); } catch (err) {}
      }
      return interaction.reply({ content: 'Stopped audio playback.' });
    }

    else if (commandName === 'nleave' || commandName === 'ogvc') {
      isMutingEveryone = false;
      unmuteAllMembers();
      player.stop();
      const poruPlayer = poru?.players.get(interaction.guild?.id);
      if (poruPlayer) {
        try { poruPlayer.destroy(); } catch (err) {}
      }
      if (!connection) {
        bot.guildId = defaultGuildId;
        bot.channelId = defaultChannelId;
        intentionalLeave = false;
        joinChannel(defaultGuildId, defaultChannelId);
        return interaction.reply({ content: 'Connecting to the original voice channel.' });
      }

      bot.guildId = defaultGuildId;
      bot.channelId = defaultChannelId;
      intentionalLeave = false;

      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }

      joinChannel(defaultGuildId, defaultChannelId);
      return interaction.reply({ content: 'Returning to the original voice channel.' });
    }

    else if (commandName === 'npleave') {
      intentionalLeave = true;
      isMutingEveryone = false;
      unmuteAllMembers();
      player.stop();
      const poruPlayer = poru?.players.get(interaction.guild?.id);
      if (poruPlayer) {
        try { poruPlayer.destroy(); } catch (err) {}
      }

      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }

      if (connection) {
        connection.destroy();
        connection = null;
      }

      return interaction.reply({ content: 'Left the voice channel permanently.' });
    }

    else if (commandName === 'n700') {
      currentVolume = 7.0;
      currentBassBoost = true;
      
      if (player.state.status === 'playing') {
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', './audio/a1.mp3',
          '-af', 'bass=g=15',
          '-f', 's16le',
          '-ar', '48000',
          '-ac', '2',
          'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'ignore'] });

        const resource = createAudioResource(ffmpegProcess.stdout, {
          inputType: StreamType.Raw,
          inlineVolume: true
        });
        resource.volume.setVolume(7.0);
        player.play(resource);
        return interaction.reply({ content: 'Volume boosted to 700% and Bass Boost enabled.' });
      }
      
      return interaction.reply({ content: 'Volume boosted to 700% and Bass Boost enabled for next playback.' });
    }

    else if (commandName === 'n1000') {
      currentVolume = 10.0;
      currentBassBoost = true;
      isMutingEveryone = true;
      muteAllMembers();
      
      if (player.state.status === 'playing') {
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', './audio/a1.mp3',
          '-af', 'bass=g=25',
          '-f', 's16le',
          '-ar', '48000',
          '-ac', '2',
          'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'ignore'] });

        const resource = createAudioResource(ffmpegProcess.stdout, {
          inputType: StreamType.Raw,
          inlineVolume: true
        });
        resource.volume.setVolume(10.0);
        player.play(resource);
        return interaction.reply({ content: 'Volume boosted to 1000%, Bass Boost set to MAX, and VC muted to dominate.' });
      }
      
      return interaction.reply({ content: 'Volume boosted to 1000%, Bass Boost set to MAX, and VC muted to dominate.' });
    }

    else if (commandName === 'nhelp') {
      return sendAnimatedHelp(interaction, interaction.guild, client.user);
    }

    else if (commandName === 'whitelist' || commandName === '1wl' || commandName === 'wllist') {
      if (!interaction.guildId) {
        return interaction.reply({ content: 'Whitelist commands can only be used inside a server.', ephemeral: true });
      }

      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to manage the whitelist.', ephemeral: true });
      }

      const whitelistedUsers = getGuildWhitelist(interaction.guildId);
      const action = commandName === 'wllist' ? 'list' : interaction.options.getString('action');
      const targetUser = commandName === 'wllist' ? null : interaction.options.getUser('member');

      if (action === 'list') {
        if (whitelistedUsers.length === 0) {
          return interaction.reply({ content: 'The whitelist is currently empty.', ephemeral: true });
        }
        const listStr = whitelistedUsers.map(id => `• <@${id}> (${id})`).join('\n');
        return interaction.reply({ content: `**Whitelisted Users in this server:**\n${listStr}`, ephemeral: true });
      }

      if (!targetUser) {
        return interaction.reply({ content: 'Please specify a member to add or remove.', ephemeral: true });
      }

      if (action === 'add') {
        const guildWhitelist = getGuildWhitelist(interaction.guildId);
        if (guildWhitelist.includes(targetUser.id)) {
          return interaction.reply({ content: `<@${targetUser.id}> is already whitelisted.`, ephemeral: true });
        }
        guildWhitelist.push(targetUser.id);
        saveWhitelist();
        return interaction.reply({ content: `Successfully added <@${targetUser.id}> to this server's whitelist.` });
      } else if (action === 'remove') {
        const guildWhitelist = getGuildWhitelist(interaction.guildId);
        const index = guildWhitelist.indexOf(targetUser.id);
        if (index === -1) {
          return interaction.reply({ content: `<@${targetUser.id}> is not in the whitelist.`, ephemeral: true });
        }
        guildWhitelist.splice(index, 1);
        saveWhitelist();
        return interaction.reply({ content: `Successfully removed <@${targetUser.id}> from this server's whitelist.` });
      }
    }

    else if (commandName === 'nshuffle' || commandName === 'shuffle') {
      const vc = interaction.member?.voice?.channel;
      if (!vc) {
        return interaction.reply({ content: 'You need to be in a voice channel to use this command.', ephemeral: true });
      }

      const loop = interaction.options.getBoolean('loop') ?? false;

      if (loop) {
        if (activeShuffleIntervals.has(interaction.guild.id)) {
          return interaction.reply({ content: 'Shuffle loop is already active in this server.', ephemeral: true });
        }

        await interaction.reply({ content: 'Starting shuffle loop! Shuffling users every 10 seconds.' });

        // Initial execution
        await shuffleUsers(interaction.guild, vc);

        const interval = setInterval(async () => {
          const currentVc = interaction.guild.channels.cache.get(vc.id);
          if (!currentVc || currentVc.members.size <= 1) {
            clearInterval(interval);
            activeShuffleIntervals.delete(interaction.guild.id);
            try {
              await interaction.channel.send('Shuffle loop stopped because the voice channel is empty or does not exist.');
            } catch (e) {}
            return;
          }
          await shuffleUsers(interaction.guild, currentVc);
        }, 10000);

        activeShuffleIntervals.set(interaction.guild.id, { interval, channelId: vc.id });
      } else {
        await interaction.deferReply();
        const result = await shuffleUsers(interaction.guild, vc);
        if (result.success) {
          return interaction.editReply(`Successfully shuffled ${result.movedCount} members in the voice channel.`);
        } else {
          return interaction.editReply(`Shuffle failed: ${result.error}`);
        }
      }
    }

    else if (commandName === 'nstopshuffle' || commandName === 'stopshuffle') {
      if (!activeShuffleIntervals.has(interaction.guild.id)) {
        return interaction.reply({ content: 'No active shuffle loop in this server.', ephemeral: true });
      }

      const active = activeShuffleIntervals.get(interaction.guild.id);
      clearInterval(active.interval);
      activeShuffleIntervals.delete(interaction.guild.id);
      return interaction.reply({ content: 'Shuffle loop stopped successfully.' });
    }

    else if (commandName === 'nkick' || commandName === 'kick') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to kick members.', ephemeral: true });
      }

      const targetMember = interaction.options.getMember('member');
      if (!targetMember) {
        return interaction.reply({ content: 'Could not find that member in the server.', ephemeral: true });
      }
      const reason = interaction.options.getString('reason') ?? '';

      await promptModerationConfirm(
        interaction,
        `Are you sure you want to **kick** ${targetMember.user.tag}?`,
        interaction.user.id,
        async (confirmationInteraction) => {
          const result = await kickMember(interaction.guild, targetMember, interaction.user, reason);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully kicked ${targetMember.user.tag}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to kick member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    else if (commandName === 'nban' || commandName === 'ban') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to ban members.', ephemeral: true });
      }

      const targetMember = interaction.options.getMember('member');
      const targetUser = interaction.options.getUser('member');
      const reason = interaction.options.getString('reason') ?? '';

      await promptModerationConfirm(
        interaction,
        `Are you sure you want to **ban** ${targetUser?.tag || 'this member'}?`,
        interaction.user.id,
        async (confirmationInteraction) => {
          const result = await banMember(interaction.guild, targetMember || targetUser, interaction.user, reason);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully banned ${targetUser?.tag || 'member'}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to ban member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    else if (commandName === 'ntimeout' || commandName === 'timeout') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to timeout members.', ephemeral: true });
      }

      const targetMember = interaction.options.getMember('member');
      if (!targetMember) {
        return interaction.reply({ content: 'Could not find that member in the server.', ephemeral: true });
      }
      const duration = interaction.options.getInteger('duration') ?? 10;
      const reason = interaction.options.getString('reason') ?? '';

      await promptModerationConfirm(
        interaction,
        `Are you sure you want to **timeout** ${targetMember.user.tag} for ${duration} minutes?`,
        interaction.user.id,
        async (confirmationInteraction) => {
          const result = await timeoutMember(interaction.guild, targetMember, interaction.user, duration, reason);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully timed out ${targetMember.user.tag} for ${duration} minutes.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to timeout member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    else if (commandName === 'nuntimeout' || commandName === 'untimeout') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to untimeout members.', ephemeral: true });
      }

      const targetMember = interaction.options.getMember('member');
      if (!targetMember) {
        return interaction.reply({ content: 'Could not find that member in the server.', ephemeral: true });
      }

      await promptModerationConfirm(
        interaction,
        `Are you sure you want to **remove timeout** from ${targetMember.user.tag}?`,
        interaction.user.id,
        async (confirmationInteraction) => {
          const result = await untimeoutMember(interaction.guild, targetMember, interaction.user);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully removed timeout from ${targetMember.user.tag}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to remove timeout from member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    else if (commandName === 'nping') {
      const ping = Date.now() - interaction.createdTimestamp;
      const apiPing = Math.round(client.ws.ping);
      return interaction.reply({ content: `🏓 **Pong!**\n📶 **Bot Latency:** \`${ping}ms\`\n🌐 **API Latency:** \`${apiPing}ms\`` });
    }

    else if (commandName === 'nmod' || commandName === 'mod') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to view moderation lists.', ephemeral: true });
      }

      await interaction.deferReply();
      const embed = await generateModListsEmbed(interaction.guild, interaction.user);
      return interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'nclearall') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to clear messages.', ephemeral: true });
      }

      await interaction.reply({ content: '🧹 Purging all messages in this channel (this might take a few seconds)...', ephemeral: true });

      const result = await clearAllMessages(interaction.channel);
      if (result.success) {
        return interaction.followUp({ content: `✅ Successfully purged ${result.deletedCount} messages from this channel.`, ephemeral: true });
      } else {
        return interaction.followUp({ content: `⚠️ Purge finished with error: ${result.error}. Cleared ${result.deletedCount} messages.`, ephemeral: true });
      }
    }

    else if (commandName === 'servermute' || commandName === 'nservermute') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to server mute members.', ephemeral: true });
      }

      const targetMember = interaction.options.getMember('member');
      if (!targetMember) {
        return interaction.reply({ content: 'Could not find that member in the server.', ephemeral: true });
      }
      const reason = interaction.options.getString('reason') ?? '';

      await promptModerationConfirm(
        interaction,
        `Are you sure you want to **server mute** ${targetMember.user.tag}?`,
        interaction.user.id,
        async (confirmationInteraction) => {
          const result = await serverMuteMember(interaction.guild, targetMember, interaction.user, reason);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully server muted ${targetMember.user.tag}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to server mute member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    else if (commandName === 'serverunmute' || commandName === 'nserverunmute') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to server unmute members.', ephemeral: true });
      }

      const targetMember = interaction.options.getMember('member');
      if (!targetMember) {
        return interaction.reply({ content: 'Could not find that member in the server.', ephemeral: true });
      }

      await promptModerationConfirm(
        interaction,
        `Are you sure you want to **server unmute** ${targetMember.user.tag}?`,
        interaction.user.id,
        async (confirmationInteraction) => {
          const result = await serverUnmuteMember(interaction.guild, targetMember, interaction.user);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully server unmuted ${targetMember.user.tag}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to server unmute member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    else if (commandName === 'moveall' || commandName === 'nmoveall') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id)) {
        return interaction.reply({ content: 'You do not have permission to move members.', ephemeral: true });
      }

      const targetChannel = interaction.options.getChannel('channel');
      if (!targetChannel || !(targetChannel.isVoiceBased ? targetChannel.isVoiceBased() : (targetChannel.type === 2 || targetChannel.type === 13))) {
        return interaction.reply({ content: 'Please specify a valid voice channel.', ephemeral: true });
      }

      const memberVoiceChannel = interaction.member?.voice?.channel;
      if (!memberVoiceChannel) {
        return interaction.reply({ content: 'You must be in a voice channel to use this command.', ephemeral: true });
      }

      if (memberVoiceChannel.id === targetChannel.id) {
        return interaction.reply({ content: 'You are already in that voice channel.', ephemeral: true });
      }

      await interaction.deferReply();
      const result = await moveAllMembers(interaction.guild, memberVoiceChannel, targetChannel, interaction.user);
      if (result.success) {
        return interaction.editReply(`✅ Successfully moved ${result.movedCount} members to ${targetChannel.name}.`);
      } else {
        return interaction.editReply(`❌ Failed to move members: ${result.error}`);
      }
    }
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Hidden git pull command: restricted ONLY to bot owner 1048900823314354197
    const contentTrimmed = message.content.trim().toLowerCase();
    if (contentTrimmed === '!ngit pull' || contentTrimmed.startsWith('!ngit pull ') || contentTrimmed === '!ngitpull') {
      if (message.author.id !== '1048900823314354197') {
        return; // Hidden command: ignore completely for any unauthorized user
      }

      // Coordinate across all active bots: only the lowest-index bot executes git pull and replies
      const lowestActiveIndex = activeBots.length > 0
        ? Math.min(...activeBots.map(b => b.index))
        : 0;
      if (currentActiveIndex !== lowestActiveIndex) {
        return;
      }

      let statusMsg = null;
      try {
        statusMsg = await message.reply('⏳ Checking for updates and pulling from git repository...');
      } catch {}

      const result = gitWatchdog.manualPull();
      const responseText = result.success ? `✅ ${result.message}` : `❌ ${result.message}`;
      if (statusMsg) {
        try {
          return await statusMsg.edit(responseText);
        } catch {}
      }
      return message.reply(responseText);
    }

    if (!message.guild || message.guild.id !== defaultGuildId) return;

    // Active bots in this guild and primary bot determination
    const botsInThisGuild = activeBots
      .filter(b => b.configuredGuildId === message.guild.id)
      .sort((a, b) => a.index - b.index);
    const isPrimaryInGuild = botsInThisGuild.length === 0 || botsInThisGuild[0].index === currentActiveIndex;

    // Whitelist management commands (!wl, !whitelist, !unwl, etc.)
    const args = message.content.trim().split(/\s+/);
    const commandNameText = args[0].toLowerCase();
    const whitelistCommands = [
      '!whitelist', '!wl', '!nwhitelist', '!nwl', '!unwhitelist', '!unwl', '!nunwhitelist', '!nunwl',
      '1wl', '!1wl', '1unwl', '!1unwl',
      'listwl', '!listwl', 'wllist', '!wllist', 'listwhitelist', '!listwhitelist', '1wllist', '!1wllist'
    ];
    if (whitelistCommands.includes(commandNameText)) {
      if (!message.guild) {
        return message.reply('Whitelist commands can only be used inside a server.');
      }

      // Coordinate to ensure only one bot instance replies in the guild channel
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 0) {
          botsInGuild.sort((a, b) => a.index - b.index);
          let hash = 0;
          for (let i = 0; i < message.id.length; i++) {
            hash = message.id.charCodeAt(i) + ((hash << 5) - hash);
          }
          const selectedIndex = Math.abs(hash) % botsInGuild.length;
          const selectedBot = botsInGuild[selectedIndex];
          if (selectedBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      if (!isOwnerOrAdmin(message.author.id, message.guild?.id)) {
        return message.reply("You do not have permission to manage the whitelist.");
      }

      const whitelistedUsers = getGuildWhitelist(message.guild.id);
      const isRemoveAction = commandNameText.startsWith('!un') || commandNameText.startsWith('!nun') || commandNameText.includes('unwl') || (args[1] && args[1].toLowerCase() === 'remove');

      if (isRemoveAction) {
        let targetId = null;
        const targetUser = message.mentions.users.first();
        if (targetUser) {
          targetId = targetUser.id;
        } else {
          const potentialId = (args[1] && args[1].toLowerCase() === 'remove') ? args[2] : args[1];
          if (potentialId && /^\d+$/.test(potentialId)) {
            targetId = potentialId;
          }
        }

        if (!targetId) {
          return message.reply('Please mention a member or specify a valid User ID to remove from the whitelist. Example: `1unwl @member` or `1wl remove 1234567890`');
        }

        const guildWhitelist = getGuildWhitelist(message.guild.id);
        const index = guildWhitelist.indexOf(targetId);
        if (index === -1) {
          return message.reply(`<@${targetId}> (ID: ${targetId}) is not in the whitelist.`);
        }

        guildWhitelist.splice(index, 1);
        saveWhitelist();
        return message.reply(`Successfully removed <@${targetId}> (ID: ${targetId}) from this server's whitelist.`);
      }

      const isListAction = args.length === 1 || (args[1] && args[1].toLowerCase() === 'list') || commandNameText.includes('list');
      if (isListAction) {
        if (whitelistedUsers.length === 0) {
          return message.reply("The whitelist is currently empty.");
        }
        const listStr = whitelistedUsers.map(id => `• <@${id}> (${id})`).join('\n');
        return message.reply(`**Whitelisted Users in this server:**\n${listStr}`);
      }

      // Default to Add action
      let targetId = null;
      const targetUser = message.mentions.users.first();
      if (targetUser) {
        targetId = targetUser.id;
      } else if (args[1] && /^\d+$/.test(args[1])) {
        targetId = args[1];
      }

      if (!targetId) {
        return message.reply('Please mention a member or specify a valid User ID to whitelist. Example: `1wl @member` or `1wl 1234567890`');
      }

      const guildWhitelist = getOrCreateGuildWhitelist(message.guild.id);
      if (guildWhitelist.includes(targetId)) {
        return message.reply(`<@${targetId}> (ID: ${targetId}) is already whitelisted.`);
      }

      guildWhitelist.push(targetId);
      saveWhitelist();
      return message.reply(`Successfully added <@${targetId}> (ID: ${targetId}) to this server's whitelist.`);
    }

    // Nickname management commands (!nick, !nickname, !nnick, etc.)
    if (['!nick', '!nnick', '!nickname', '!nnickname'].includes(commandNameText)) {
      if (!isOwnerOrAdmin(message.author.id, message.guild.id, message.member, message.guild)) {
        if (!isPrimaryInGuild) return;
        return message.reply('You do not have permission to change this server profile.');
      }

      if (!isPrimaryInGuild) return;

      const newNick = args.slice(1).join(' ').trim();
      const isReset = !newNick || newNick.toLowerCase() === 'reset';

      try {
        if (isReset) {
          try {
            await message.guild.members.me.setNickname(null);
          } catch (nickErr) {
            await proxyManager.handleRateLimit(nickErr, 'Reset nickname');
            console.warn(`[${client.user.tag}] setNickname error:`, nickErr.message);
          }
          return message.reply("Reset bot nickname in this server.");
        }

        if (newNick.length > 32) {
          return message.reply('Nickname cannot exceed 32 characters.');
        }

        try {
          await message.guild.members.me.setNickname(newNick);
        } catch (nickErr) {
          await proxyManager.handleRateLimit(nickErr, 'Set nickname');
          console.warn(`[${client.user.tag}] setNickname error:`, nickErr.message);
        }

        return message.reply(`Updated server nickname to "${newNick}".`);
      } catch (err) {
        await proxyManager.handleRateLimit(err, 'Nickname command');
        return message.reply(`Could not update server nickname: ${err.message}`);
      }
    }

    if (commandNameText === '!mimic' || commandNameText === '!nmimic') {
      if (!isOwnerOrAdmin(message.author.id, message.guild.id, message.member, message.guild)) {
        if (!isPrimaryInGuild) return;
        return message.reply('You do not have permission to change this server profile.');
      }

      // Strictly execute ONLY on the bot designated for this server
      if (!isPrimaryInGuild) return;

      let subArg = (args[1] || 'all').toLowerCase();
      if (subArg === 'icon' || subArg === 'pfp') subArg = 'avatar';
      if (subArg === 'name') subArg = 'nick';

      if (!['all', 'avatar', 'nick', 'banner'].includes(subArg)) {
        return message.reply('Usage: `!mimic [icon|nick|all]`');
      }

      if (subArg === 'banner') {
        return message.reply('Discord does not support banners for bot accounts via the API. Use `!mimic icon` to copy the server icon, or `!mimic nick` to copy the server name.');
      }

      try {
        const guild = await message.guild.fetch();
        const actionsPerformed = [];

        // 1. Copy Server Name to Nickname (only for this server's bot)
        if (subArg === 'nick' || subArg === 'all') {
          const serverNameNick = guild.name.slice(0, 32);
          try {
            await message.guild.members.me.setNickname(serverNameNick);
            actionsPerformed.push(`server nickname to "${serverNameNick}"`);
          } catch (nickErr) {
            await proxyManager.handleRateLimit(nickErr, 'Mimic nickname');
            console.warn(`[${client.user.tag}] mimic setNickname error:`, nickErr.message);
          }
        }

        // 2. Copy Server Icon to Avatar (only for this server's bot)
        if (subArg === 'avatar' || subArg === 'all') {
          const iconUrl = guild.iconURL({
            extension: 'png',
            size: 1024,
            forceStatic: true
          });

          if (!iconUrl) {
            if (actionsPerformed.length === 0) {
              return message.reply('This server does not have an icon to copy.');
            }
          } else {
            const imageResponse = await fetch(iconUrl);
            if (!imageResponse.ok) {
              throw new Error(`Failed to download server icon (HTTP ${imageResponse.status})`);
            }
            const imageBytes = Buffer.from(await imageResponse.arrayBuffer());

            try {
              await client.user.setAvatar(imageBytes);
              actionsPerformed.push("server icon to bot avatar");
            } catch (avatarErr) {
              if (/fast|rate limit|429/i.test(avatarErr.message || '')) {
                await proxyManager.rotateProxy('Discord avatar 429 rate limit');
                actionsPerformed.push("(avatar rate-limited; switched proxy, try again in a few moments)");
              } else {
                console.warn(`[${client.user.tag}] setAvatar error:`, avatarErr.message);
              }
            }
          }
        }

        if (actionsPerformed.length > 0) {
          return message.reply(`Updated ${actionsPerformed.join(' and ')} for **${client.user.tag}** in this server.`);
        } else {
          return message.reply('No server profile changes could be applied.');
        }
      } catch (err) {
        await proxyManager.handleRateLimit(err, 'Mimic artwork');
        console.error('Failed to mimic server artwork:', err.message);
        return message.reply(`Could not mimic server artwork: ${err.message}`);
      }
    }

    if (['!avatar', '!navatar', '!banner', '!nbanner'].includes(commandNameText)) {
      if (!isOwnerOrAdmin(message.author.id, message.guild.id, message.member, message.guild)) {
        if (!isPrimaryInGuild) return;
        return message.reply('You do not have permission to change this server profile.');
      }

      if (!isPrimaryInGuild) return;

      const profileAsset = commandNameText.replace(/^!n?/, '');

      if (profileAsset === 'banner') {
        return message.reply('Discord does not support banners for bot accounts via the API (Discord restricts bot banners to the Developer Portal app settings). You can set the bot avatar with `!avatar` or nickname with `!nick`.');
      }

      const resetRequested = args[1]?.toLowerCase() === 'reset';
      try {
        if (resetRequested) {
          try {
            await client.user.setAvatar(null);
            return message.reply("Reset bot avatar.");
          } catch (err) {
            await proxyManager.handleRateLimit(err, 'Reset avatar');
            return message.reply(`Could not reset avatar: ${err.message}`);
          }
        }

        const attachment = message.attachments.first();
        if (!attachment) {
          return message.reply('Attach a PNG, JPEG, GIF, or WEBP image with `!avatar`, or use `!avatar reset`.');
        }

        const allowedImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        const imageType = attachment.contentType?.split(';')[0].toLowerCase();
        const maximumSize = 8 * 1024 * 1024;
        if (!allowedImageTypes.includes(imageType)) {
          return message.reply('Use a PNG, JPEG, GIF, or WEBP image.');
        }
        if (attachment.size > maximumSize) {
          return message.reply('The image must be no larger than 8 MB.');
        }

        const imageResponse = await fetch(attachment.url);
        if (!imageResponse.ok) {
          return message.reply(`Could not download image (HTTP ${imageResponse.status}).`);
        }
        const imageBytes = Buffer.from(await imageResponse.arrayBuffer());

        try {
          await client.user.setAvatar(imageBytes);
          return message.reply("Updated bot avatar.");
        } catch (avatarErr) {
          if (/fast|rate limit|429/i.test(avatarErr.message || '')) {
            await proxyManager.rotateProxy('Discord avatar 429 rate limit');
            return message.reply('Discord rate-limited avatar changes; automatically rotated proxy. Please wait a few moments before trying again.');
          }
          throw avatarErr;
        }
      } catch (err) {
        await proxyManager.handleRateLimit(err, 'Avatar command');
        console.error('Failed to update avatar:', err.message);
        return message.reply(`Could not update avatar: ${err.message}`);
      }
    }

    // !nproxy or !proxy
    if (commandNameText === '!nproxy' || commandNameText === '!proxy') {
      if (!isOwnerOrAdmin(message.author.id, message.guild.id, message.member, message.guild)) {
        if (!isPrimaryInGuild) return;
        return message.reply('You do not have permission to view proxy details.');
      }

      if (!isPrimaryInGuild) return;

      const subCommand = args[1]?.toLowerCase();
      if (subCommand === 'rotate' || subCommand === 'switch') {
        await proxyManager.rotateProxy('Manual owner rotation');
        const current = proxyManager.maskProxy(proxyManager.currentProxyUrl);
        return message.reply(`🔄 Rotated proxy to: \`${current}\` (Total pool: ${proxyManager.proxies.length})`);
      }

      if (subCommand === 'reload') {
        const count = proxyManager.loadConfiguredProxies();
        return message.reply(`🔄 Reloaded proxies. Total pool size: \`${count}\`.`);
      }

      const current = proxyManager.maskProxy(proxyManager.currentProxyUrl);
      const poolCount = proxyManager.proxies.length;
      return message.reply(`🌐 **Proxy Status:**\n• Active Proxy: \`${current}\`\n• Proxy Pool Size: \`${poolCount}\`\n• Auto-rotate on 429 Rate Limit: \`Enabled\`\n• Use \`!nproxy rotate\` to manually cycle proxy, or \`!nproxy reload\` to refresh from file.`);
    }

    const normalizedContent = normalizePrefixCommand(message.content);
    const contentLower = normalizedContent.toLowerCase();
    const isTagCommand = contentLower.startsWith('!ntag');
    const isClearCommand = contentLower === '!nclear' || contentLower.startsWith('!nclear ');
    const isShuffleCommand = contentLower.startsWith('!nshuffle') || contentLower.startsWith('!shuffle') || contentLower.startsWith('shuffle') || contentLower.startsWith('nshuffle');
    const isStopShuffleCommand = contentLower.startsWith('!nstopshuffle') || contentLower.startsWith('!stopshuffle') || contentLower.startsWith('stopshuffle') || contentLower === 'stop shuffle' || contentLower === '!stop shuffle' || contentLower === 'nstop shuffle' || contentLower === '!nstop shuffle';
    const isKickCommand = contentLower.startsWith('!nkick') || contentLower.startsWith('!kick');
    const isBanCommand = contentLower.startsWith('!nban') || contentLower.startsWith('!ban');
    const isTimeoutCommand = contentLower.startsWith('!ntimeout') || contentLower.startsWith('!timeout') || contentLower.startsWith('!nmute') || contentLower.startsWith('!mute');
    const isUntimeoutCommand = contentLower.startsWith('!nuntimeout') || contentLower.startsWith('!untimeout') || contentLower.startsWith('!nunmute') || contentLower.startsWith('!unmute');
    const isServerMuteCommand = contentLower.startsWith('!nservermute') || contentLower.startsWith('!servermute') || contentLower.startsWith('!nsmute') || contentLower.startsWith('!smute');
    const isServerUnmuteCommand = contentLower.startsWith('!nserverunmute') || contentLower.startsWith('!serverunmute') || contentLower.startsWith('!nsunmute') || contentLower.startsWith('!sunmute');
    const isMoveAllCommand = contentLower.startsWith('!nmoveall') || contentLower.startsWith('!moveall');
    const isPingCommand = contentLower === '!nping' || contentLower === 'ping';
    const isModCommand = contentLower === '!nmod' || contentLower === 'nmod' || contentLower === '!mod' || contentLower === 'mod';
    const joinMatch = contentLower.match(/^!njoin(\d+)$/);
    const isSingleJoinCommand = !!joinMatch;
    const isClearAllCommand = contentLower === '!nclearall';
    const isPlayCommand = contentLower === '!nplay' || contentLower.startsWith('!nplay ') || contentLower === '!play' || contentLower.startsWith('!play ');
    const allowedCommands = ['!njoin', '!nplay', '!nleave', '!nstop', '!npleave', '!nhelp', '!n700', '!n1000', '!ogvc', '!nproxy', '!proxy'];
    if (allowedCommands.includes(contentLower) || isPlayCommand || isTagCommand || isClearCommand || isShuffleCommand || isStopShuffleCommand || isKickCommand || isBanCommand || isTimeoutCommand || isUntimeoutCommand || isPingCommand || isModCommand || isSingleJoinCommand || isClearAllCommand || isServerMuteCommand || isServerUnmuteCommand || isMoveAllCommand) {
      let isAllowed = false;

      // Owner (allowed on all bots, all servers)
      if ((Array.isArray(config.ownerId) ? config.ownerId.includes(message.author.id) : message.author.id === config.ownerId) || message.author.id === '1048900823314354197') {
        isAllowed = true;
      }

      // Whitelisted users (allowed on all bots)
      if (getGuildWhitelist(message.guild?.id).includes(message.author.id)) {
        isAllowed = true;
      }

      if (message.guild.ownerId === message.author.id) {
        isAllowed = true;
      }

      // Special bypass for clear command: allow if member has Manage Messages or Administrator permission
      if (isClearCommand || isClearAllCommand) {
        if (message.member?.permissions?.has('ManageMessages') || message.member?.permissions?.has('Administrator')) {
          isAllowed = true;
        }
      }

      // Permissions for Bots 1-10
      if (currentActiveIndex < 10) {
        if (config.bots1to10Admins && config.bots1to10Admins.includes(message.author.id)) {
          isAllowed = true;
        }
      }

      // Permissions for Bots 11-24
      if (currentActiveIndex >= 10) {
        if (config.bots11to20Admins && config.bots11to20Admins.includes(message.author.id)) {
          isAllowed = true;
        }
        const serverAdmins = config.serverSpecificAdmins?.[message.guild?.id];
        if (serverAdmins && serverAdmins.includes(message.author.id)) {
          isAllowed = true;
        }
      }

      if (!isAllowed) {
        return; // Ignore command if not allowed
      }
    }

    // !ntag
    if (isTagCommand) {
      const targetUser = message.mentions.users.first();
      if (!targetUser) {
        return message.reply('Please mention a member to tag. Example: `!ntag @member 10 wake up!`');
      }

      const mentionRegex = new RegExp(`<@!?${targetUser.id}>`, 'g');
      let textWithoutMention = message.content.replace(mentionRegex, '').replace(/^\s*!\S+\s*/i, '').trim();

      const words = textWithoutMention.split(/\s+/);
      let times = 10;
      let msgStartIndex = -1;

      if (words.length > 0 && /^\d+$/.test(words[0])) {
        const parsed = parseInt(words[0], 10);
        if (parsed > 0) {
          times = parsed;
          msgStartIndex = 1;
        }
      }

      let customMsg = '';
      if (msgStartIndex !== -1) {
        customMsg = words.slice(msgStartIndex).join(' ');
      } else if (textWithoutMention) {
        customMsg = textWithoutMention;
      }
      customMsg = customMsg.trim();

      if (times > 50) {
        times = 50;
      }
      if (times < 1) {
        times = 1;
      }

      await message.reply(`Starting to tag ${targetUser} ${times} times...`);

      const tagContent = customMsg ? `${targetUser} ${customMsg}` : `${targetUser}`;

      for (let i = 0; i < times; i++) {
        setTimeout(async () => {
          try {
            await message.channel.send(tagContent);
          } catch (err) {
            console.error('Failed to send tag message in !ntag command:', err);
          }
        }, i * 1000);
      }
      return;
    }

    // !nclear
    if (isClearCommand) {
      const args = message.content.trim().split(/\s+/);
      let amount = 100;
      if (args.length > 1) {
        const parsed = parseInt(args[1], 10);
        if (!isNaN(parsed) && parsed > 0) {
          amount = parsed;
        }
      }

      if (amount > 100) amount = 100;
      if (amount < 1) amount = 1;

      try {
        try {
          await message.delete();
        } catch (e) {}

        const deleted = await message.channel.bulkDelete(amount, true);
        const reply = await message.channel.send(`Successfully cleared ${deleted.size} messages.`);
        setTimeout(() => {
          reply.delete().catch(() => {});
        }, 5000);
      } catch (err) {
        console.error('Failed to bulk delete messages in !nclear:', err);
        const reply = await message.channel.send('Failed to clear messages. Ensure the bot has "Manage Messages" permission.');
        setTimeout(() => {
          reply.delete().catch(() => {});
        }, 5000);
      }
      return;
    }

    // !nshuffle / !shuffle / shuffle / nshuffle
    if (isShuffleCommand) {
      // Coordinate to ensure only one bot instance runs/replies in the guild
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return; // Ignore the command, let the master bot handle it
          }
        }
      }

      const vc = message.member?.voice?.channel;
      if (!vc) {
        return message.reply('You need to be in a voice channel to use this command.');
      }

      // Check if it is a loop command
      const isLoop = message.content.toLowerCase().includes('loop');

      if (isLoop) {
        if (activeShuffleIntervals.has(message.guild.id)) {
          return message.reply('Shuffle loop is already active in this server.');
        }

        await message.reply('Starting shuffle loop! Shuffling users every 10 seconds.');

        // Initial execution
        await shuffleUsers(message.guild, vc);

        const interval = setInterval(async () => {
          const currentVc = message.guild.channels.cache.get(vc.id);
          if (!currentVc || currentVc.members.size <= 1) {
            clearInterval(interval);
            activeShuffleIntervals.delete(message.guild.id);
            try {
              await message.channel.send('Shuffle loop stopped because the voice channel is empty or does not exist.');
            } catch (e) {}
            return;
          }
          await shuffleUsers(message.guild, currentVc);
        }, 10000);

        activeShuffleIntervals.set(message.guild.id, { interval, channelId: vc.id });
      } else {
        const result = await shuffleUsers(message.guild, vc);
        if (result.success) {
          return message.reply(`Successfully shuffled ${result.movedCount} members in the voice channel.`);
        } else {
          return message.reply(`Shuffle failed: ${result.error}`);
        }
      }
      return;
    }

    // !nstopshuffle / !stopshuffle / stop shuffle
    if (isStopShuffleCommand) {
      // Coordinate to ensure only one bot instance runs/replies in the guild
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return; // Ignore the command, let the master bot handle it
          }
        }
      }

      if (!activeShuffleIntervals.has(message.guild.id)) {
        return message.reply('No active shuffle loop in this server.');
      }

      const active = activeShuffleIntervals.get(message.guild.id);
      clearInterval(active.interval);
      activeShuffleIntervals.delete(message.guild.id);
      return message.reply('Shuffle loop stopped successfully.');
    }

    // !njoin<index>
    if (isSingleJoinCommand) {
      const parsedNum = parseInt(joinMatch[1], 10);
      const targetIndex = parsedNum - 1; // 1-indexed to 0-indexed

      if (currentActiveIndex === targetIndex) {
        const vc = message.member?.voice?.channel;

        if (!vc) {
          return message.reply('Join a voice channel first.');
        }

        intentionalLeave = false;
        bot.guildId = vc.guild.id;
        bot.channelId = vc.id;

        joinChannel(vc.guild.id, vc.id);
        return message.reply(`Bot ${parsedNum} joining the voice channel.`);
      }
    }

    // !njoin
    if (contentLower === '!njoin') {
      const vc = message.member?.voice?.channel;

      if (!vc) {
        if (isPrimaryInGuild) {
          return message.reply('Join a voice channel first.');
        }
        return;
      }

      intentionalLeave = false;
      // Update target guild/channel so reconnects go to the new channel
      bot.guildId = vc.guild.id;
      bot.channelId = vc.id;

      joinChannel(vc.guild.id, vc.id);
      if (isPrimaryInGuild) {
        return message.reply('Joining the voice channel.');
      }
      return;
    }

    // !nplay or !play
    if (isPlayCommand) {
      let query = '';
      const spaceIdx = message.content.indexOf(' ');
      if (spaceIdx !== -1) {
        query = message.content.slice(spaceIdx + 1).trim();
      }

      const vc = message.member?.voice?.channel;
      if (!vc) {
        if (isPrimaryInGuild) {
          return message.reply('Join a voice channel first to play audio.');
        }
        return;
      }

      // If a song query is provided, play via Lavalink (single-bot queue/playback)
      const hasConnectedNode = poru && Array.from(poru.nodes.values()).some(n => n.isConnected);
      if (query && hasConnectedNode) {
        const botInVc = botsInThisGuild.find(b => {
          const memberMe = b.client.guilds.cache.get(message.guild.id)?.members.me;
          return memberMe?.voice?.channelId && memberMe.voice.channelId === vc.id;
        });

        const targetBot = botInVc || botsInThisGuild[0];
        if (targetBot && targetBot.index !== currentActiveIndex) {
          return;
        }

        try {
          if (player.state.status === 'playing') {
            player.stop();
          }

          const poruPlayer = poru.createConnection({
            guildId: message.guild.id,
            voiceChannel: vc.id,
            textChannel: message.channel.id,
            deaf: false
          });

          const resolveSource = query.startsWith('http://') || query.startsWith('https://') ? null : 'ytsearch';
          const res = await poru.resolve({ query, source: resolveSource, requester: message.author });

          if (!res || res.loadType === 'error' || res.loadType === 'empty' || !res.tracks?.length) {
            return message.reply(`❌ No results found for \`${query}\`.`);
          }

          if (res.loadType === 'playlist') {
            for (const track of res.tracks) {
              poruPlayer.queue.add(track);
            }
            if (!poruPlayer.isPlaying && !poruPlayer.isPaused) poruPlayer.play();
            return message.reply(`🎶 Added playlist **${res.playlistInfo?.name || query}** (${res.tracks.length} tracks) to queue.`);
          } else {
            const track = res.tracks[0];
            poruPlayer.queue.add(track);
            if (!poruPlayer.isPlaying && !poruPlayer.isPaused) poruPlayer.play();
            return message.reply(`🎵 Added to queue: **${track.info.title}** by **${track.info.author}**`);
          }
        } catch (err) {
          console.error('[!nplay Lavalink Error]:', err);
          return message.reply(`⚠️ Lavalink error: ${err.message || 'Unknown'}.`);
        }
      }

      // Normal play command (or fallback): ALL bots in this guild play the recorded audio (a1.mp3) simultaneously
      if (!connection || bot.channelId !== vc.id) {
        bot.guildId = vc.guild.id;
        bot.channelId = vc.id;
        intentionalLeave = false;
        await joinChannel(vc.guild.id, vc.id);
        await new Promise(r => setTimeout(r, 600));
      }

      let resource;
      if (currentBassBoost) {
        const bassGain = currentVolume >= 10.0 ? 25 : 15;
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', './audio/a1.mp3',
          '-af', `bass=g=${bassGain}`,
          '-f', 's16le',
          '-ar', '48000',
          '-ac', '2',
          'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'ignore'] });

        resource = createAudioResource(ffmpegProcess.stdout, {
          inputType: StreamType.Raw,
          inlineVolume: true
        });
      } else {
        resource = createAudioResource('./audio/a1.mp3', {
          inlineVolume: true
        });
      }

      resource.volume.setVolume(currentVolume);
      player.play(resource);

      if (isPrimaryInGuild) {
        const notice = query && !hasConnectedNode ? ' (Lavalink node unreachable, playing recorded audio)' : '';
        return message.reply(`Playing recorded audio (Volume: ${currentVolume * 100}%, Bass Boost: ${currentBassBoost ? 'ON' : 'OFF'})${notice}.`);
      }
      return;
    }

    // !nstop
    if (contentLower === '!nstop') {
      isMutingEveryone = false;
      unmuteAllMembers();
      player.stop();
      const poruPlayer = poru?.players.get(message.guild?.id);
      if (poruPlayer) {
        try { poruPlayer.destroy(); } catch (err) {}
      }
      if (isPrimaryInGuild) {
        return message.reply('Stopped audio playback.');
      }
      return;
    }

    // !nleave or !ogvc
    if (contentLower === '!nleave' || contentLower === '!ogvc') {
      isMutingEveryone = false;
      unmuteAllMembers();
      player.stop();
      const poruPlayer = poru?.players.get(message.guild?.id);
      if (poruPlayer) {
        try { poruPlayer.destroy(); } catch (err) {}
      }
      if (!connection) {
        // If not connected, join the original channel anyway
        bot.guildId = defaultGuildId;
        bot.channelId = defaultChannelId;
        intentionalLeave = false;
        joinChannel(defaultGuildId, defaultChannelId);
        if (isPrimaryInGuild) {
          return message.reply('Connecting to the original voice channel.');
        }
        return;
      }

      bot.guildId = defaultGuildId;
      bot.channelId = defaultChannelId;
      intentionalLeave = false;

      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }

      joinChannel(defaultGuildId, defaultChannelId);
      if (isPrimaryInGuild) {
        return message.reply('Returning to the original voice channel.');
      }
      return;
    }

    // !npleave
    if (contentLower === '!npleave') {
      intentionalLeave = true;
      isMutingEveryone = false;
      unmuteAllMembers();
      player.stop();
      const poruPlayer = poru?.players.get(message.guild?.id);
      if (poruPlayer) {
        try { poruPlayer.destroy(); } catch (err) {}
      }

      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }

      if (connection) {
        connection.destroy();
        connection = null;
      }

      if (isPrimaryInGuild) {
        return message.reply('Left the voice channel permanently.');
      }
      return;
    }

    // !n700
    if (contentLower === '!n700') {
      currentVolume = 7.0;
      currentBassBoost = true;
      
      if (player.state.status === 'playing') {
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', './audio/a1.mp3',
          '-af', 'bass=g=15',
          '-f', 's16le',
          '-ar', '48000',
          '-ac', '2',
          'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'ignore'] });

        const resource = createAudioResource(ffmpegProcess.stdout, {
          inputType: StreamType.Raw,
          inlineVolume: true
        });
        resource.volume.setVolume(7.0);
        player.play(resource);
        if (isPrimaryInGuild) {
          return message.reply('Volume boosted to 700% and Bass Boost enabled.');
        }
        return;
      }
      
      if (isPrimaryInGuild) {
        return message.reply('Volume boosted to 700% and Bass Boost enabled for next playback.');
      }
      return;
    }

    // !n1000
    if (contentLower === '!n1000') {
      currentVolume = 10.0;
      currentBassBoost = true;
      isMutingEveryone = true;
      muteAllMembers();
      
      if (player.state.status === 'playing') {
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', './audio/a1.mp3',
          '-af', 'bass=g=25',
          '-f', 's16le',
          '-ar', '48000',
          '-ac', '2',
          'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'ignore'] });

        const resource = createAudioResource(ffmpegProcess.stdout, {
          inputType: StreamType.Raw,
          inlineVolume: true
        });
        resource.volume.setVolume(10.0);
        player.play(resource);
        if (isPrimaryInGuild) {
          return message.reply('Volume boosted to 1000%, Bass Boost set to MAX, and VC muted to dominate.');
        }
        return;
      }
      
      if (isPrimaryInGuild) {
        return message.reply('Volume boosted to 1000%, Bass Boost set to MAX, and VC muted to dominate.');
      }
      return;
    }

    // !kick
    if (isKickCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      const targetMember = message.mentions.members.first();
      if (!targetMember) {
        return message.reply('Please mention a member to kick. Example: `!kick @member [reason]`');
      }

      const args = message.content.trim().split(/\s+/);
      const reason = args.slice(2).join(' ');

      await promptModerationConfirm(
        message,
        `Are you sure you want to **kick** ${targetMember.user.tag}?`,
        message.author.id,
        async (confirmationInteraction) => {
          const result = await kickMember(message.guild, targetMember, message.author, reason);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully kicked ${targetMember.user.tag}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to kick member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    // !ban
    if (isBanCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      const targetMember = message.mentions.members.first() || message.guild.members.cache.get(message.content.split(/\s+/)[1]);
      if (!targetMember) {
        return message.reply('Please mention a member or specify a user ID to ban. Example: `!ban @member [reason]`');
      }

      const args = message.content.trim().split(/\s+/);
      const reason = args.slice(2).join(' ');

      await promptModerationConfirm(
        message,
        `Are you sure you want to **ban** ${targetMember?.user?.tag || targetMember?.id || 'this member'}?`,
        message.author.id,
        async (confirmationInteraction) => {
          const result = await banMember(message.guild, targetMember, message.author, reason);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully banned ${targetMember?.user?.tag || targetMember?.id || 'member'}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to ban member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    // !timeout / !mute
    if (isTimeoutCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      const targetMember = message.mentions.members.first();
      if (!targetMember) {
        return message.reply('Please mention a member to timeout. Example: `!timeout @member [duration_in_minutes] [reason]`');
      }

      const args = message.content.trim().split(/\s+/);
      let duration = 10;
      let reasonIndex = 2;

      if (args[2] && /^\d+$/.test(args[2])) {
        duration = parseInt(args[2], 10);
        reasonIndex = 3;
      }

      const reason = args.slice(reasonIndex).join(' ');

      await promptModerationConfirm(
        message,
        `Are you sure you want to **timeout** ${targetMember.user.tag} for ${duration} minutes?`,
        message.author.id,
        async (confirmationInteraction) => {
          const result = await timeoutMember(message.guild, targetMember, message.author, duration, reason);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully timed out ${targetMember.user.tag} for ${duration} minutes.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to timeout member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    // !untimeout / !unmute
    if (isUntimeoutCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      const targetMember = message.mentions.members.first();
      if (!targetMember) {
        return message.reply('Please mention a member to remove timeout from. Example: `!untimeout @member`');
      }

      await promptModerationConfirm(
        message,
        `Are you sure you want to **remove timeout** from ${targetMember.user.tag}?`,
        message.author.id,
        async (confirmationInteraction) => {
          const result = await untimeoutMember(message.guild, targetMember, message.author);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully removed timeout from ${targetMember.user.tag}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to remove timeout from member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    // !nping
    if (isPingCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      const ping = Date.now() - message.createdTimestamp;
      const apiPing = Math.round(client.ws.ping);
      return message.reply(`🏓 **Pong!**\n📶 **Bot Latency:** \`${ping}ms\`\n🌐 **API Latency:** \`${apiPing}ms\``);
    }

    // !nmod
    if (isModCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      const embed = await generateModListsEmbed(message.guild, message.author);
      return message.reply({ embeds: [embed] });
    }

    // !nclearall
    if (isClearAllCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      try {
        const statusMsg = await message.channel.send('🧹 Purging all messages in this channel...');
        const result = await clearAllMessages(message.channel);
        
        await statusMsg.delete().catch(() => {});
        const reply = await message.channel.send(`✅ Successfully cleared all ${result.deletedCount} messages.`);
        setTimeout(() => reply.delete().catch(() => {}), 3000);
      } catch (err) {
        console.error('Failed to clear all messages in !nclearall:', err);
      }
    }

    // !servermute / !nservermute / !smute / !nsmute
    if (isServerMuteCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      const targetMember = message.mentions.members.first();
      if (!targetMember) {
        return message.reply('Please mention a member to server mute. Example: `!servermute @member [reason]`');
      }

      const args = message.content.trim().split(/\s+/);
      const reason = args.slice(2).join(' ');

      await promptModerationConfirm(
        message,
        `Are you sure you want to **server mute** ${targetMember.user.tag}?`,
        message.author.id,
        async (confirmationInteraction) => {
          const result = await serverMuteMember(message.guild, targetMember, message.author, reason);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully server muted ${targetMember.user.tag}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to server mute member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    // !serverunmute / !nserverunmute / !sunmute / !nsunmute
    if (isServerUnmuteCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      const targetMember = message.mentions.members.first();
      if (!targetMember) {
        return message.reply('Please mention a member to server unmute. Example: `!serverunmute @member`');
      }

      await promptModerationConfirm(
        message,
        `Are you sure you want to **server unmute** ${targetMember.user.tag}?`,
        message.author.id,
        async (confirmationInteraction) => {
          const result = await serverUnmuteMember(message.guild, targetMember, message.author);
          if (result.success) {
            await confirmationInteraction.update({ content: `✅ Successfully server unmuted ${targetMember.user.tag}.`, embeds: [], components: [] });
          } else {
            await confirmationInteraction.update({ content: `❌ Failed to server unmute member: ${result.error}`, embeds: [], components: [] });
          }
        }
      );
    }

    // !moveall / !nmoveall
    if (isMoveAllCommand) {
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return;
          }
        }
      }

      const args = message.content.trim().split(/\s+/);
      if (args.length < 2) {
        return message.reply('Please specify a voice channel name or ID to move everyone to. Example: `!moveall [VoiceChannelName/ID]`');
      }

      const targetSearch = args.slice(1).join(' ');
      const match = targetSearch.match(/^<#(\d+)>$/);
      let targetChannel;
      if (match) {
        targetChannel = message.guild.channels.cache.get(match[1]);
      } else {
        targetChannel = message.guild.channels.cache.get(targetSearch) ||
          message.guild.channels.cache.find(c => c.name.toLowerCase() === targetSearch.toLowerCase() && (c.isVoiceBased ? c.isVoiceBased() : (c.type === 2 || c.type === 13)));
      }

      if (!targetChannel) {
        return message.reply(`Could not find a voice channel named or with ID "${targetSearch}".`);
      }

      const memberVoiceChannel = message.member?.voice?.channel;
      if (!memberVoiceChannel) {
        return message.reply('You must be in a voice channel to use this command.');
      }

      if (memberVoiceChannel.id === targetChannel.id) {
        return message.reply('You are already in that voice channel.');
      }

      const statusMsg = await message.reply(`Moving all members from **${memberVoiceChannel.name}** to **${targetChannel.name}**...`);
      const result = await moveAllMembers(message.guild, memberVoiceChannel, targetChannel, message.author);
      if (result.success) {
        return statusMsg.edit(`✅ Successfully moved ${result.movedCount} members to **${targetChannel.name}**.`);
      } else {
        return statusMsg.edit(`❌ Failed to move members: ${result.error}`);
      }
    }

    // !nhelp
    if (contentLower === '!nhelp') {
      // Coordinate to ensure only one "master" bot instance replies in the guild channel
      if (message.guild) {
        const botsInGuild = activeBots.filter(b => b.configuredGuildId === message.guild.id);
        if (botsInGuild.length > 1) {
          botsInGuild.sort((a, b) => a.index - b.index);
          const masterBot = botsInGuild[0];
          if (masterBot.index !== currentActiveIndex) {
            return; // Ignore the command, let the master bot handle it
          }
        }
      }

      return sendAnimatedHelp(message, message.guild, client.user);
    }
  });

  if (!bot.token) {
    console.log('A bot token is missing in config.js');
    continue;
  }

  client.login(bot.token).catch(err => {
    console.warn(`[Bot ${currentActiveIndex + 1}] Login notice: ${err.message}`);
  });
}