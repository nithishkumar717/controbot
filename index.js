const { Client, GatewayIntentBits, ActivityType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const { LavalinkManager } = require('lavalink-client');

const config = require('./config');
const fs = require('fs');
const path = require('path');
const ffmpegStatic = require('ffmpeg-static');
const ffmpegBin = ffmpegStatic || 'ffmpeg';
process.env.FFMPEG_PATH = ffmpegBin;
const defaultAudioPath = path.join(__dirname, 'audio', 'a1.mp3');
const gitWatchdog = require('./git-watchdog');

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

// Helper to check if a user is a bot owner
function isBotOwner(userId) {
  if (!userId) return false;
  const uid = String(userId);
  if (Array.isArray(config.ownerId)) {
    if (config.ownerId.map(String).includes(uid)) return true;
  } else if (config.ownerId && String(config.ownerId) === uid) {
    return true;
  }
  return uid === '1048900823314354197';
}

// Helper to check if a user is an owner or administrator
function isOwnerOrAdmin(userId, guildId, member = null, guild = null) {
  if (!userId) return false;

  if (isBotOwner(userId)) {
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
const songManagersByGuild = new Map();

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

// Copy server profile fields to this bot's guild-specific member profile.
async function executeMimic(guild, client, subArg) {
  try {
    const fetchedGuild = await guild.fetch();
    const actionsPerformed = [];
    const notes = [];
    const editGuildProfile = async fields => fetchedGuild.members.editMe(fields);

    // Nicknames, avatars, banners, and bios are edited on the guild member,
    // so mimicking one server never changes the bot's global profile.
    if (subArg === 'nick' || subArg === 'all') {
      const serverNameNick = fetchedGuild.name.slice(0, 32);
      try {
        await editGuildProfile({ nick: serverNameNick });
        actionsPerformed.push(`server nickname to "${serverNameNick}"`);
      } catch (nickErr) {
        notes.push(`Nickname error: ${nickErr.message}`);
      }
    }

    // Server icon to this bot's guild-specific avatar.
    if (subArg === 'avatar' || subArg === 'icon' || subArg === 'all') {
      const iconUrl = fetchedGuild.iconURL({
        extension: 'png',
        size: 1024,
        forceStatic: true
      });

      if (!iconUrl) {
        notes.push('Server has no icon to copy');
      } else {
        try {
          const imageResponse = await fetch(iconUrl);
          if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`);
          const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
          await editGuildProfile({ avatar: imageBytes });
          actionsPerformed.push('server icon to this server’s bot avatar');
        } catch (avatarErr) {
          if (/fast|rate limit|429/i.test(avatarErr.message || '')) {
            notes.push(`Avatar rate-limited: ${avatarErr.message}`);
          } else {
            notes.push(`Avatar error: ${avatarErr.message}`);
          }
        }
      }
    }

    // Server banner to this bot's guild-specific banner.
    if (subArg === 'banner' || subArg === 'all') {
      const bannerUrl = fetchedGuild.bannerURL({ extension: 'png', size: 1024 });

      if (!bannerUrl) {
        notes.push('Server has no banner to copy');
      } else {
        try {
          const bannerRes = await fetch(bannerUrl);
          if (!bannerRes.ok) throw new Error(`HTTP ${bannerRes.status}`);
          const bannerBuf = Buffer.from(await bannerRes.arrayBuffer());
          await editGuildProfile({ banner: bannerBuf });
          actionsPerformed.push('server banner to this server’s bot banner');
        } catch (bannerErr) {
          notes.push(`Banner note: ${bannerErr.message}`);
        }
      }
    }

    // Server description to this bot's guild-specific bio.
    if (subArg === 'bio' || subArg === 'all') {
      const serverBio = fetchedGuild.description?.trim();
      if (!serverBio) {
        notes.push('Server has no description to copy as a bio');
      } else {
        try {
          await editGuildProfile({ bio: serverBio });
          actionsPerformed.push('server description to this server’s bot bio');
        } catch (bioErr) {
          notes.push(`Bio note: ${bioErr.message}`);
        }
      }
    }

    let summary = '';
    if (actionsPerformed.length > 0) {
      summary += `✅ Updated ${actionsPerformed.join(' and ')} for **${client.user.tag}**.`;
    } else {
      summary += `⚠️ No server profile elements could be mimicked.`;
    }
    if (notes.length > 0) {
      summary += `\n*Details: ${notes.join('; ')}*`;
    }
    return summary;
  } catch (err) {
    return `❌ Could not mimic server profile: ${err.message}`;
  }
}

// Helper to send a progressively building animated help catalog
async function sendAnimatedHelp(target, guild, clientUser) {
  const avatarUrl = clientUser.displayAvatarURL({ dynamic: true, size: 128 });
  const isSlash = !!target.editReply;

  const plainTextHelp = `✨ **COMMAND CATALOG** ✨\n\n` +
    `**🔊 VOICE & MUSIC**\n` +
    `• \`!join\` / \`!join[num]\` : Join your voice channel (e.g. \`!join25\`)\n` +
    `• \`!play\` / \`!stop\` : Play recorded audio or stop playback\n` +
    `• \`!playsong <song or URL>\` / \`!ps <song or URL>\` or \`/playsong\` : Search and play songs through Lavalink\n` +
    `• \`!leave\` : Return to the configured voice channel\n` +
    `• \`!pleave\` : Disconnect from voice\n` +
    `• \`!700\` / \`!1000\` : Set boosted playback volume\n\n` +
    `**🛡️ MANAGEMENT & UTILITY**\n` +
    `• \`!wl [add|remove|list] @member\` : Manage this server's whitelist\n` +
    `• \`!clear [count]\` / \`!clearall\` : Clear messages\n` +
    `• \`!servermute @member\` / \`!serverunmute @member\`\n` +
    `• \`!moveall [voice channel]\` : Move voice channel members\n` +
    `• \`!nick [new name]\` / \`!nick reset\` : Set or reset server nickname\n` +
    `• \`!avatar\` + image / \`!avatar reset\` : Set or reset bot avatar\n` +
    `• \`!bio [text]\` / \`!bio reset\` : Set or reset bot About Me bio\n` +
    `• \`!mimic\` : Copy this server's icon, banner, description, and name to the bot's server profile\n` +
    `• \`!ping\` / \`!mod\` : Latency and moderation lists\n\n` +
    `**🔥 TROLL & FUN**\n` +
    `• \`!tag @member [count] [message]\` : Repeat a tag\n` +
    `• \`!shuffle\` : Shuffle members from your voice channel\n` +
    `• \`!shuffle loop\` / \`!stopshuffle\` : Start or stop repeated shuffling`;

  // Pre-check if bot can send embeds in this channel
  let canEmbed = true;
  if (!isSlash && target.channel && clientUser?.id) {
    try {
      const perms = target.channel.permissionsFor(clientUser.id);
      if (perms && !perms.has(PermissionFlagsBits.EmbedLinks)) {
        canEmbed = false;
      }
    } catch {
      canEmbed = false;
    }
  }

  // If bot lacks EmbedLinks permission, immediately send clean plain text markdown
  if (!canEmbed && !isSlash) {
    try {
      return await target.reply(plainTextHelp);
    } catch {
      return await target.channel.send(plainTextHelp);
    }
  }

  // Initial Loading Embed
  const loadEmbed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('⚡ Fetching Commands...')
    .setDescription('Gathering system modules and preparing help index...')
    .setThumbnail(avatarUrl)
    .setImage('https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExd2R4aWcxaXk1djUzYW8xaWVxdWJjM2lyNHVwcjNsMXR2aTRwYXZhdiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3y0oCOkdKKRi0/giphy.gif')
    .setTimestamp();

  let msg;
  try {
    if (isSlash) {
      await target.reply({ embeds: [loadEmbed] });
    } else {
      try {
        msg = await target.reply({ embeds: [loadEmbed] });
      } catch (replyErr) {
        msg = await target.channel.send({ embeds: [loadEmbed] });
      }
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
      value: `• \`!join\` / \`!join[num]\` : Join your voice channel (e.g. \`!join25\`)\n• \`!play\` / \`!stop\` : Play recorded audio or stop playback\n• \`!playsong <song or URL>\` / \`!ps <song or URL>\` or \`/playsong\` : Play songs through Lavalink\n• \`!leave\` : Return to the configured voice channel\n• \`!pleave\` : Disconnect from voice\n• \`!700\` / \`!1000\` : Set boosted playback volume`
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
      value: `• \`!wl [add|remove|list] @member\` : Manage this server's whitelist\n• \`!clear [count]\` / \`!clearall\` : Clear messages\n• \`!servermute @member\` / \`!serverunmute @member\`\n• \`!moveall [voice channel]\` : Move voice channel members\n• \`!nick [new name]\` / \`!nick reset\` : Set or reset server nickname\n• \`!avatar\` + image / \`!avatar reset\` : Set or reset bot avatar\n• \`!bio [text]\` / \`!bio reset\` : Set or reset bot About Me bio\n• \`!mimic\` : Copy this server's icon, banner, description, and name to the bot's server profile\n• \`!ping\` / \`!mod\` : Latency and moderation lists`
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
    console.error('Failed to send animated help menu:', err?.message || err);
    try {
      if (isSlash) {
        if (target.replied || target.deferred) {
          await target.editReply({ content: plainTextHelp, embeds: [] });
        } else {
          await target.reply({ content: plainTextHelp, ephemeral: true });
        }
      } else {
        try {
          await target.reply(plainTextHelp);
        } catch {
          await target.channel.send(plainTextHelp);
        }
      }
    } catch (fallbackErr) {
      console.error('Failed to send fallback plain text help:', fallbackErr?.message || fallbackErr);
    }
  }
}

// Prevent global process crashes from unhandled rejections or uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
  const reasonStr = (String(reason?.message || reason || '') + ' ' + String(reason?.stack || '')).toLowerCase();
  if (
    reasonStr.includes('poru') ||
    reasonStr.includes('econnrefused') ||
    reasonStr.includes('socket closed') ||
    reasonStr.includes('cannot perform ip discovery') ||
    reasonStr.includes('wrongepoch') ||
    reasonStr.includes('dave') ||
    reasonStr.includes('failed to process proposals') ||
    reasonStr.includes('messageprocessingfailed') ||
    reasonStr.includes('validationerror')
  ) {
    return;
  }
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  const errStr = (String(err?.message || err || '') + ' ' + String(err?.stack || '')).toLowerCase();
  if (
    errStr.includes('wrongepoch') ||
    errStr.includes('dave') ||
    errStr.includes('failed to process proposals') ||
    errStr.includes('messageprocessingfailed') ||
    errStr.includes('validationerror') ||
    errStr.includes('cannot perform ip discovery') ||
    errStr.includes('socket closed')
  ) {
    return;
  }
  console.error('Uncaught Exception thrown:', err);
});

// Guild-level audio managers: a single shared AudioPlayer per guild for perfectly synchronized, ultra-lightweight multi-bot playback
const guildAudioManagers = new Map();

function getGuildAudioManager(guildId) {
  if (!guildAudioManagers.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    player.on('stateChange', (oldState, newState) => {
      if (newState.status === 'idle') {
        const mgr = guildAudioManagers.get(guildId);
        if (mgr?.isMutingEveryone) {
          mgr.isMutingEveryone = false;
          unmuteAllGuildMembers(guildId);
        }
      }
    });

    player.on('error', (err) => {
      console.warn(`[GuildAudioPlayer ${guildId}] Playback notice: ${err.message}`);
    });

    guildAudioManagers.set(guildId, {
      player,
      currentVolume: 1.0,
      currentBassBoost: false,
      isMutingEveryone: false,
    });
  }
  return guildAudioManagers.get(guildId);
}

function playGuildAudio(guildId, options = {}) {
  const mgr = getGuildAudioManager(guildId);
  if (!mgr) return;

  if (options.volume !== undefined) mgr.currentVolume = options.volume;
  if (options.bassBoost !== undefined) mgr.currentBassBoost = options.bassBoost;

  let resource;
  if (mgr.currentBassBoost) {
    const bassGain = mgr.currentVolume >= 10.0 ? 25 : 15;
    const ffmpegProcess = spawn(ffmpegBin, [
      '-i', defaultAudioPath,
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
    resource = createAudioResource(defaultAudioPath, {
      inlineVolume: true
    });
  }

  resource.volume.setVolume(mgr.currentVolume);
  mgr.player.play(resource);
}

async function restoreRecordedVoiceForGuild(guildId, channelId) {
  const songHost = songManagersByGuild.get(guildId);
  if (!songHost) return;

  const player = songHost.client.lavalink?.getPlayer(guildId);
  if (player) {
    songHost.switchingToRecorded = true;
    await player.destroy('Switching to recorded audio').catch(() => {});
    songHost.switchingToRecorded = false;
  }

  songHost.restoreVoice(channelId);
}

async function playSongWithLavalink({ guildId, voiceChannelId, textChannelId, query, requester }) {
  const songHost = songManagersByGuild.get(guildId);
  const manager = songHost?.client.lavalink;
  if (!songHost || !manager) {
    throw new Error('Song playback is not ready for this server yet.');
  }

  songHost.releaseVoiceForSong();
  songHost.bot.guildId = guildId;
  songHost.bot.channelId = voiceChannelId;
  let player;
  try {
    player = manager.getPlayer(guildId);
    if (!player) {
      player = manager.createPlayer({
        guildId,
        voiceChannelId,
        textChannelId,
        selfDeaf: false,
        selfMute: false,
      });
    } else if (player.voiceChannelId !== voiceChannelId) {
      await player.changeVoiceState({ voiceChannelId, selfDeaf: false });
    }

    await player.connect();
    const result = await player.search(query, requester);
    if (!result.tracks?.length) {
      throw new Error('No songs matched that search.');
    }

    const alreadyPlaying = player.playing;
    const tracks = result.loadType === 'playlist' ? result.tracks : [result.tracks[0]];
    player.queue.add(tracks);
    if (!player.playing) await player.play();
    return { title: tracks[0].info.title, queuedCount: tracks.length, alreadyPlaying };
  } catch (err) {
    songHost.switchingToRecorded = true;
    if (player) await player.destroy('Song request failed').catch(() => {});
    songHost.switchingToRecorded = false;
    songHost.restoreVoice(voiceChannelId);
    throw err;
  }
}

function stopGuildAudio(guildId) {
  const mgr = guildAudioManagers.get(guildId);
  if (mgr) {
    mgr.isMutingEveryone = false;
    mgr.player.stop();
    unmuteAllGuildMembers(guildId);
  }
}

async function muteAllGuildMembers(guildId, channelId) {
  const botsInGuild = activeBots.filter(b => b.configuredGuildId === guildId || b.client?.guilds?.cache?.has(guildId));
  const masterBot = botsInGuild[0];
  if (!masterBot) return;
  try {
    const guild = masterBot.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!channel) return;
    for (const [memberId, member] of channel.members) {
      if (botsInGuild.some(b => b.client.user.id === memberId)) continue;
      if (!member.voice.mute) {
        try { await member.voice.setMute(true, 'Bot dominating VC'); } catch {}
      }
    }
  } catch {}
}

async function unmuteAllGuildMembers(guildId, channelId = null) {
  const botsInGuild = activeBots.filter(b => b.configuredGuildId === guildId || b.client?.guilds?.cache?.has(guildId));
  const masterBot = botsInGuild[0];
  if (!masterBot) return;
  try {
    const guild = masterBot.client.guilds.cache.get(guildId);
    if (!guild) return;
    const channels = channelId ? [guild.channels.cache.get(channelId)].filter(Boolean) : Array.from(guild.channels.cache.values()).filter(c => c.isVoiceBased?.() || c.type === 2);
    for (const ch of channels) {
      for (const [memberId, member] of ch.members) {
        if (botsInGuild.some(b => b.client.user.id === memberId)) continue;
        if (member.voice.mute) {
          try { await member.voice.setMute(false, 'Bot domination ended'); } catch {}
        }
      }
    }
  } catch {}
}

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

  let connection = null;
  let reconnectTimeout = null;
  let connectionTimeout = null;
  let intentionalLeave = false;
  let isJoining = false;

  // Main voice channel join logic
  const joinChannel = async (guildId, channelId) => {
    if (bot._lavalinkOwnsVoice) return;

    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    if (isJoining) return;

    // If already connected or establishing connection to this exact channel, don't interrupt
    if (connection && (connection.state.status === VoiceConnectionStatus.Ready || connection.state.status === VoiceConnectionStatus.Connecting || connection.state.status === VoiceConnectionStatus.Signalling)) {
      if (connection.joinConfig.channelId === channelId) {
        return;
      }
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

      // Clean standard voice connection with bot-isolated group ID
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        group: client.user.id,
      });

      const guildAudio = getGuildAudioManager(guild.id);
      connection.subscribe(guildAudio.player);

      // Start watchdog timer (45 seconds) to handle genuinely stuck handshakes
      connectionTimeout = setTimeout(() => {
        if (connection && connection.state.status !== VoiceConnectionStatus.Ready && connection.state.status !== VoiceConnectionStatus.Destroyed) {
          if (!bot._warnedStuck) {
            bot._warnedStuck = true;
            console.warn(`[${client.user.tag}] Voice connection pending (${connection.state.status}). Reconnecting...`);
          }
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          isJoining = false;
          try {
            connection.destroy();
          } catch {}
          connection = null;
          if (!intentionalLeave) {
            triggerReconnect();
          }
        }
      }, 45000);

      // Prevent crash by handling errors on the connection instance
      connection.on('error', (err) => {
        const now = Date.now();
        if (!bot._lastVoiceErrTime || now - bot._lastVoiceErrTime > 30000 || bot._lastVoiceErrMsg !== err.message) {
          bot._lastVoiceErrTime = now;
          bot._lastVoiceErrMsg = err.message;
          console.warn(`[${client.user.tag}] Voice notice: ${err.message}`);
        }
      });

      // Listen for connection status changes using official @discordjs/voice patterns
      connection.on('stateChange', async (oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Ready) {
          isJoining = false;
          bot._warnedStuck = false;
          bot._reconnectAttempts = 0;
          connection.rejoinAttempts = 0;
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          if (!bot._hasConnectedVoice) {
            bot._hasConnectedVoice = true;
            console.log(`[${client.user.tag}] Connected to voice: ${guild.name} -> ${channel.name}`);
          }
          try {
            const guildAudio = getGuildAudioManager(guild.id);
            connection.subscribe(guildAudio.player);
          } catch {}
        }

        if (newState.status === VoiceConnectionStatus.Destroyed) {
          isJoining = false;
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
        }

        // Handle disconnects gracefully with auto-rejoin before hard destroying
        if (newState.status === VoiceConnectionStatus.Disconnected && !intentionalLeave) {
          if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
            // Channel move or server switch: wait to see if it shifts to Signalling or Connecting
            try {
              await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5000),
              ]);
              return;
            } catch {
              // Genuinely disconnected
              isJoining = false;
              try {
                connection.destroy();
              } catch {}
              connection = null;
              bot._hasConnectedVoice = false;
              triggerReconnect();
              return;
            }
          } else if ((connection.rejoinAttempts || 0) < 5) {
            // Temporary network drop: attempt clean rejoin without destroying the connection
            connection.rejoinAttempts = (connection.rejoinAttempts || 0) + 1;
            await new Promise(r => setTimeout(r, connection.rejoinAttempts * 2500));
            if (connection && connection.state.status === VoiceConnectionStatus.Disconnected) {
              try {
                connection.rejoin();
                return;
              } catch {}
            } else {
              return;
            }
          }

          isJoining = false;
          try {
            connection.destroy();
          } catch {}
          connection = null;
          bot._hasConnectedVoice = false;
          triggerReconnect();
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

  // Reconnection helper with progressive backoff and jitter
  const triggerReconnect = () => {
    if (reconnectTimeout) return;

    bot._reconnectAttempts = (bot._reconnectAttempts || 0) + 1;
    const baseDelay = Math.min(30000, 4000 * Math.min(6, bot._reconnectAttempts));
    const reconnectDelay = baseDelay + Math.floor(Math.random() * 4000);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      if (!intentionalLeave && bot.guildId && bot.channelId) {
        joinChannel(bot.guildId, bot.channelId);
      }
    }, reconnectDelay);
  };

  client.once('clientReady', async () => {
    console.log(`${client.user.tag} is online`);

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
          console.warn(`[${client.user.tag}] Could not set avatar: ${avatarErr.message}`);
        }
      } else {
        console.warn(`[${client.user.tag}] Avatar file not found: ${resolvedPath}`);
      }
    }

    // Add to active bots list
    const activeBotEntry = {
      index: currentActiveIndex,
      client: client,
      configuredGuildId: defaultGuildId,
      bot: bot,
      joinChannel: (gid, cid) => joinChannel(gid, cid),
      getConnection: () => connection,
      releaseVoiceForSong: () => {
        bot._lavalinkOwnsVoice = true;
        intentionalLeave = true;
        isJoining = false;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        if (connectionTimeout) clearTimeout(connectionTimeout);
        reconnectTimeout = null;
        connectionTimeout = null;
        if (connection) {
          connection.removeAllListeners();
          connection.destroy();
          connection = null;
        }
      },
      switchingToRecorded: false,
      restoreVoice: (channelId = bot.channelId || defaultChannelId) => {
        bot._lavalinkOwnsVoice = false;
        intentionalLeave = false;
        bot.guildId = defaultGuildId;
        bot.channelId = channelId;
        if (defaultGuildId && channelId) joinChannel(defaultGuildId, channelId);
      },
    };
    activeBots.push(activeBotEntry);

    // One Lavalink manager per server, independent of the recorded-audio player.
    if (defaultGuildId && !songManagersByGuild.has(defaultGuildId)) {
      const manager = new LavalinkManager({
        nodes: [{
          id: 'nerdx-live-lavalink',
          host: config.lavalink.host,
          port: config.lavalink.port,
          authorization: config.lavalink.password,
          secure: config.lavalink.secure,
        }],
        sendToShard: (guildId, payload) => {
          const guild = client.guilds.cache.get(guildId);
          guild?.shard?.send(payload);
        },
        autoSkip: true,
        client: {
          id: client.user.id,
          username: client.user.username,
        },
        playerOptions: {
          defaultSearchPlatform: 'ytmsearch',
          onDisconnect: { autoReconnect: true, destroyPlayer: false },
          onEmptyQueue: { destroyAfterMs: 30000 },
        },
      });
      client.lavalink = manager;
      client.on('raw', packet => manager.sendRawData(packet));
      manager.nodeManager.on('error', (_node, err) => {
        console.warn(`[Lavalink ${defaultGuildId}] ${err.message}`);
      });
      manager.nodeManager.on('connect', node => {
        console.log(`[Lavalink ${defaultGuildId}] Connected to ${node.id}`);
      });
      manager.on('playerDestroy', player => {
        if (bot._lavalinkOwnsVoice && !activeBotEntry.switchingToRecorded && player.guildId === defaultGuildId) {
          activeBotEntry.restoreVoice();
        }
      });
      songManagersByGuild.set(defaultGuildId, activeBotEntry);
      manager.init({ ...client.user }).catch(err => {
        console.warn(`[Lavalink ${defaultGuildId}] Startup failed: ${err.message}`);
      });
    }

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
          description: 'Plays the multi-bot recorded audio',
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
          name: 'playsong',
          description: 'Searches for a song and plays it through Lavalink',
          options: [
            {
              name: 'query',
              type: 3,
              description: 'Song title, artist, or direct URL',
              required: true,
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
          name: 'help',
          description: 'Shows the command catalog and help message'
        },
        {
          name: 'nhelp',
          description: 'Shows the command catalog and help message'
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
        },
        {
          name: 'bio',
          description: 'Set or reset the bot About Me / bio',
          options: [
            {
              name: 'text',
              type: 3, // STRING
              description: 'The new bio text (leave empty or "reset" to clear)',
              required: false,
            }
          ]
        },
        {
          name: 'mimic',
          description: 'Copy server profile fields to this bot’s guild-specific profile',
          options: [
            {
              name: 'option',
              type: 3, // STRING
              description: 'Which profile element to mimic',
              required: false,
              choices: [
                { name: 'All (Icon, Banner, Bio, Nick)', value: 'all' },
                { name: 'Icon (Avatar)', value: 'avatar' },
                { name: 'Banner', value: 'banner' },
                { name: 'Bio (Server Description)', value: 'bio' },
                { name: 'Nickname', value: 'nick' }
              ]
            }
          ]
        }
      ], defaultGuildId);
      // Slash commands registered
    } catch (err) {
      console.warn(`[${client.user.tag}] Slash commands note: ${err.message}`);
    }

    if (bot.guildId && bot.channelId) {
      intentionalLeave = false;
      const staggerDelay = (currentActiveIndex % 10) * 1200;
      setTimeout(() => {
        if (!intentionalLeave && bot.guildId && bot.channelId) {
          joinChannel(bot.guildId, bot.channelId);
        }
      }, staggerDelay);
    }

    // 24/7 Voice Channel Watchdog: Ensure bot remains inside configured VC permanently
    setInterval(() => {
      if (bot._lavalinkOwnsVoice) return;
      if (intentionalLeave) return;
      const targetGuildId = defaultGuildId || bot.guildId;
      const targetChannelId = defaultChannelId || bot.channelId;
      if (!targetGuildId || !targetChannelId) return;

      const guild = client.guilds.cache.get(targetGuildId);
      if (!guild) return;

      const memberMe = guild.members.me;
      const inVoice = memberMe?.voice?.channelId;

      if (!inVoice || !connection || connection.state.status === VoiceConnectionStatus.Destroyed || connection.state.status === VoiceConnectionStatus.Disconnected) {
        if (!isJoining && !reconnectTimeout) {
          joinChannel(targetGuildId, targetChannelId);
        }
      }
    }, 25000);
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    if (bot.guildId && newState.guild.id !== bot.guildId) return;

    if (newState.member.id !== client.user.id) {
      const mgr = getGuildAudioManager(newState.guild.id);
      if (mgr.isMutingEveryone && newState.channelId === bot.channelId) {
        if (!newState.mute) {
          try {
            await newState.setMute(true, 'Bot dominating VC');
          } catch (err) {}
        }
      }
      return;
    }

    if (bot._lavalinkOwnsVoice) return;

    if (!newState.channelId) {
      if (bot._hasConnectedVoice) {
        bot._hasConnectedVoice = false;
      }
      if (!intentionalLeave) {
        // If connection is already destroyed or lost, trigger reconnect immediately for 24/7 uptime
        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
          triggerReconnect();
        }
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
      'tag', 'clear', 'njoin', 'nplay', 'nleave', 'nstop', 'npleave', 'n700', 'n1000', 'ogvc', 'help', 'nhelp', 'whitelist', '1wl',
      'nshuffle', 'nstopshuffle', 'shuffle', 'stopshuffle',
      'wllist',
      'nping', 'nmod', 'mod', 'nclearall',
      'servermute', 'nservermute', 'serverunmute', 'nserverunmute', 'moveall', 'nmoveall',
      'playgame', 'bio', 'mimic', 'playsong'
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

    // Allow anyone to use help or playgame
    if (commandName === 'help' || commandName === 'nhelp' || commandName === 'playgame' || commandName === 'playsong') {
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

    else if (commandName === 'playsong') {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({ content: 'Join a voice channel first to play a song.', ephemeral: true });
      }
      const query = interaction.options.getString('query', true).trim();
      if (!query) {
        return interaction.reply({ content: 'Enter a song title, artist, or URL.', ephemeral: true });
      }

      await interaction.deferReply();
      try {
        const result = await playSongWithLavalink({
          guildId: interaction.guildId,
          voiceChannelId: voiceChannel.id,
          textChannelId: interaction.channelId,
          query,
          requester: interaction.user,
        });
        const action = result.alreadyPlaying ? 'Queued' : 'Playing';
        return interaction.editReply(`🎵 ${action}: **${result.title}**${result.queuedCount > 1 ? ` (+${result.queuedCount - 1} playlist tracks)` : ''}`);
      } catch (err) {
        console.error(`[Lavalink ${interaction.guildId}] Song request failed: ${err.message}`);
        return interaction.editReply(`Could not play that song: ${err.message}`);
      }
    }

    else if (commandName === 'nplay') {
      const vc = interaction.member?.voice?.channel;
      const targetVcId = vc ? vc.id : (bot.channelId || defaultChannelId);

      if (!targetVcId) {
        return interaction.reply({ content: 'Join a voice channel first to play audio.', ephemeral: true });
      }

      await restoreRecordedVoiceForGuild(interaction.guildId, targetVcId);

      // Ensure all bots in this guild join the voice channel
      const guildBots = activeBots.filter(b => b.configuredGuildId === interaction.guildId || b.client?.guilds?.cache?.has(interaction.guildId));
      for (const b of guildBots) {
        if (b.bot.channelId !== targetVcId) {
          b.bot.guildId = interaction.guildId;
          b.bot.channelId = targetVcId;
          b.joinChannel(interaction.guildId, targetVcId);
        }
      }

      const mgr = getGuildAudioManager(interaction.guildId);
      mgr.currentVolume = 10.0;
      playGuildAudio(interaction.guildId, { volume: mgr.currentVolume, bassBoost: mgr.currentBassBoost });

      return interaction.reply({ content: `Playing recorded audio across ${guildBots.length || 1} bot(s) in sync (Volume: 1000%, Bass Boost: ${mgr.currentBassBoost ? 'ON' : 'OFF'}).` });
    }

    else if (commandName === 'nstop') {
      stopGuildAudio(interaction.guildId);
      return interaction.reply({ content: 'Stopped audio playback across all bots.' });
    }

    else if (commandName === 'nleave' || commandName === 'ogvc') {
      stopGuildAudio(interaction.guildId);

      const guildBots = activeBots.filter(b => b.configuredGuildId === interaction.guildId || b.client?.guilds?.cache?.has(interaction.guildId));
      for (const b of guildBots) {
        b.bot.guildId = b.configuredGuildId;
        b.bot.channelId = b.bot.channelId || defaultChannelId;
        b.joinChannel(b.configuredGuildId, b.bot.channelId);
      }

      return interaction.reply({ content: 'Returning bots to the original voice channel.' });
    }

    else if (commandName === 'npleave') {
      intentionalLeave = true;
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

      stopGuildAudio(interaction.guildId);
      return interaction.reply({ content: 'Left the voice channel permanently.' });
    }

    else if (commandName === 'n700') {
      const mgr = getGuildAudioManager(interaction.guildId);
      mgr.currentVolume = 7.0;
      mgr.currentBassBoost = true;
      
      if (mgr.player.state.status === 'playing') {
        playGuildAudio(interaction.guildId, { volume: 7.0, bassBoost: true });
        return interaction.reply({ content: 'Volume boosted to 700% and Bass Boost enabled across all bots.' });
      }
      
      return interaction.reply({ content: 'Volume boosted to 700% and Bass Boost enabled for next playback.' });
    }

    else if (commandName === 'n1000') {
      const mgr = getGuildAudioManager(interaction.guildId);
      mgr.currentVolume = 10.0;
      mgr.currentBassBoost = true;
      mgr.isMutingEveryone = true;
      const vc = interaction.member?.voice?.channel;
      if (vc) muteAllGuildMembers(interaction.guildId, vc.id);
      
      if (mgr.player.state.status === 'playing') {
        playGuildAudio(interaction.guildId, { volume: 10.0, bassBoost: true });
        return interaction.reply({ content: 'Volume boosted to 1000%, Bass Boost set to MAX, and VC muted across all bots.' });
      }
      
      return interaction.reply({ content: 'Volume boosted to 1000%, Bass Boost set to MAX, and VC muted to dominate.' });
    }

    else if (commandName === 'nhelp' || commandName === 'help') {
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

    else if (commandName === 'bio') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id, interaction.member, interaction.guild)) {
        return interaction.reply({ content: 'You do not have permission to change the bot bio.', ephemeral: true });
      }
      const bioText = interaction.options.getString('text')?.trim() || '';
      const newBio = bioText.toLowerCase() === 'reset' ? '' : bioText;
      try {
        await client.rest.patch(Routes.user(), { body: { bio: newBio } });
        return interaction.reply({ content: newBio ? `✅ Updated **${client.user.tag}** bio to: "${newBio}"` : `✅ Reset **${client.user.tag}** bio.` });
      } catch (err) {
        return interaction.reply({ content: `❌ Could not update bio: ${err.message}`, ephemeral: true });
      }
    }

    else if (commandName === 'mimic') {
      if (!isOwnerOrAdmin(interaction.user.id, interaction.guild?.id, interaction.member, interaction.guild)) {
        return interaction.reply({ content: 'You do not have permission to change this server profile.', ephemeral: true });
      }
      const opt = interaction.options.getString('option') || 'all';
      await interaction.deferReply();
      const res = await executeMimic(interaction.guild, client, opt);
      return interaction.editReply({ content: res });
    }
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Git pull command: restricted to bot owners (supports !git pull, git pull, !pull, pull, !ngit pull, !ngitpull, etc.)
    const contentTrimmed = message.content.trim().toLowerCase();
    const isGitPullCmd = ['!ngit pull', '!git pull', 'git pull', '!pull', 'pull', '!ngitpull', '!gitpull', '!npull'].some(p => contentTrimmed === p || contentTrimmed.startsWith(p + ' '));
    if (isGitPullCmd) {
      if (!isBotOwner(message.author.id)) {
        return; // Hidden command: ignore completely for any unauthorized user
      }

      // Coordinate across active bots: pick the bot that has permission to send in this channel
      let shouldRespond = false;
      if (message.guild) {
        const guildBots = activeBots.filter(b => b.configuredGuildId === message.guild.id || b.client?.guilds?.cache?.has(message.guild.id)).sort((a, b) => a.index - b.index);
        const botsWithSend = guildBots.filter(b => {
          try {
            const p = message.channel.permissionsFor(b.client.user.id);
            return p && p.has(PermissionFlagsBits.ViewChannel) && p.has(PermissionFlagsBits.SendMessages);
          } catch { return false; }
        });
        const picker = botsWithSend.length > 0 ? botsWithSend[0] : (guildBots[0] || activeBots[0]);
        shouldRespond = !picker || picker.index === currentActiveIndex;
      } else {
        const lowestActiveIndex = activeBots.length > 0 ? Math.min(...activeBots.map(b => b.index)) : 0;
        shouldRespond = currentActiveIndex === lowestActiveIndex;
      }

      if (!shouldRespond) return;

      let statusMsg = null;
      try {
        statusMsg = await message.reply('⏳ Checking for updates and pulling from git repository...');
      } catch {
        try { statusMsg = await message.channel.send('⏳ Checking for updates and pulling from git repository...'); } catch {}
      }

      const result = gitWatchdog.manualPull();
      const responseText = result.success ? `✅ ${result.message}` : `❌ ${result.message}`;
      if (statusMsg) {
        try {
          return await statusMsg.edit(responseText);
        } catch {}
      }
      try {
        return await message.reply(responseText);
      } catch {
        return await message.channel.send(responseText);
      }
    }

    if (!message.guild || message.guild.id !== defaultGuildId) return;

    // Active bots in this guild
    let botsInThisGuild = activeBots
      .filter(b => b.configuredGuildId === message.guild.id)
      .sort((a, b) => a.index - b.index);

    if (botsInThisGuild.length === 0) {
      botsInThisGuild = activeBots
        .filter(b => b.client.guilds.cache.has(message.guild.id))
        .sort((a, b) => a.index - b.index);
    }

    // Determine which bot in this guild has permission to send messages and view channel in this specific channel
    const botsWithPermission = botsInThisGuild.filter(b => {
      try {
        const perms = message.channel.permissionsFor(b.client.user.id);
        return perms && perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.SendMessages);
      } catch {
        return false;
      }
    });

    // The designated responder is the first bot with permissions, or botsInThisGuild[0] as fallback
    const respondingBot = botsWithPermission.length > 0 ? botsWithPermission[0] : botsInThisGuild[0];
    const isPrimaryInGuild = !respondingBot || respondingBot.index === currentActiveIndex;

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
          console.warn(`[${client.user.tag}] setNickname error:`, nickErr.message);
        }

        return message.reply(`Updated server nickname to "${newNick}".`);
      } catch (err) {
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

      let subArg = (args[1] || '').toLowerCase();
      if (subArg === 'icon' || subArg === 'pfp') subArg = 'avatar';
      if (subArg === 'name') subArg = 'nick';

      if (!subArg) {
        // Show interactive options: Icon, Banner, Nickname, All
        const mimicEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('🎭 Mimic Server Profile')
          .setDescription(
            `Choose which fields to copy from **${message.guild.name}** to this bot's profile in this server:\n\n` +
            `• 🖼️ **Icon (Avatar)** — Copy the server icon to the bot's server avatar\n` +
            `• 🎨 **Banner** — Copy the server banner to the bot's server banner\n` +
            `• 📝 **Bio** — Copy the server description to the bot's server bio\n` +
            `• 🏷️ **Nickname** — Match the bot's nickname to this server name\n` +
            `• ✨ **All** — Copy all available fields`
          )
          .setFooter({ text: 'Click an option button below' });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('mimic_btn_icon').setLabel('Icon (Avatar)').setStyle(ButtonStyle.Primary).setEmoji('🖼️'),
          new ButtonBuilder().setCustomId('mimic_btn_banner').setLabel('Banner').setStyle(ButtonStyle.Secondary).setEmoji('🎨'),
          new ButtonBuilder().setCustomId('mimic_btn_bio').setLabel('Bio').setStyle(ButtonStyle.Secondary).setEmoji('📝'),
          new ButtonBuilder().setCustomId('mimic_btn_nick').setLabel('Nickname').setStyle(ButtonStyle.Success).setEmoji('🏷️'),
          new ButtonBuilder().setCustomId('mimic_btn_all').setLabel('All').setStyle(ButtonStyle.Danger).setEmoji('✨')
        );

        let mimicMsg;
        try {
          mimicMsg = await message.reply({ embeds: [mimicEmbed], components: [row] });
        } catch {
          mimicMsg = await message.channel.send({ embeds: [mimicEmbed], components: [row] });
        }

        const filter = i => isOwnerOrAdmin(i.user.id, message.guild.id, i.member, message.guild);
        const collector = mimicMsg.createMessageComponentCollector({ filter, time: 60000 });

        collector.on('collect', async (interaction) => {
          await interaction.deferUpdate();
          collector.stop('handled');

          let choice = 'all';
          if (interaction.customId === 'mimic_btn_icon') choice = 'avatar';
          else if (interaction.customId === 'mimic_btn_banner') choice = 'banner';
          else if (interaction.customId === 'mimic_btn_bio') choice = 'bio';
          else if (interaction.customId === 'mimic_btn_nick') choice = 'nick';
          else if (interaction.customId === 'mimic_btn_all') choice = 'all';

          const res = await executeMimic(message.guild, client, choice);
          try {
            await mimicMsg.edit({ content: res, embeds: [], components: [] });
          } catch {
            await message.channel.send(res);
          }
        });

        collector.on('end', async (_, reason) => {
          if (reason !== 'handled') {
            try {
              const disabledRow = ActionRowBuilder.from(row);
              disabledRow.components.forEach(c => c.setDisabled(true));
              await mimicMsg.edit({ components: [disabledRow] });
            } catch {}
          }
        });

        return;
      }

      if (!['all', 'avatar', 'nick', 'banner', 'bio'].includes(subArg)) {
        return message.reply('Usage: `!mimic` (interactive menu) or `!mimic [icon|nick|banner|bio|all]`');
      }

      const res = await executeMimic(message.guild, client, subArg);
      return message.reply(res);
    }

    // Bio management commands (!bio, !nbio)
    if (commandNameText === '!bio' || commandNameText === '!nbio') {
      if (!isOwnerOrAdmin(message.author.id, message.guild.id, message.member, message.guild)) {
        if (!isPrimaryInGuild) return;
        return message.reply('You do not have permission to change the bot bio.');
      }

      if (!isPrimaryInGuild) return;

      const subArg = args[1]?.toLowerCase();
      if (!subArg) {
        return message.reply('Usage: `!bio <text>` to set bio, `!bio all <text>` for all bots, or `!bio reset` to clear bio.');
      }

      if (subArg === 'all') {
        const allBioText = args.slice(2).join(' ').trim();
        const newBio = allBioText.toLowerCase() === 'reset' ? '' : allBioText;
        const botsToUpdate = activeBots.filter(b => b.configuredGuildId === message.guild.id || b.client?.guilds?.cache?.has(message.guild.id));
        let updatedCount = 0;
        for (const b of botsToUpdate) {
          try {
            await b.client.rest.patch(Routes.user(), { body: { bio: newBio } });
            updatedCount++;
          } catch {}
        }
        return message.reply(newBio ? `✅ Updated bio for ${updatedCount} bot(s) to: "${newBio}"` : `✅ Reset bio for ${updatedCount} bot(s).`);
      }

      const bioText = args.slice(1).join(' ').trim();
      const newBio = bioText.toLowerCase() === 'reset' ? '' : bioText;
      try {
        await client.rest.patch(Routes.user(), {
          body: { bio: newBio }
        });
        return message.reply(newBio ? `✅ Updated **${client.user.tag}** bio to: "${newBio}"` : `✅ Reset **${client.user.tag}** bio.`);
      } catch (err) {
        console.warn(`[${client.user.tag}] set bio error:`, err.message);
        return message.reply(`❌ Could not update bio: ${err.message}`);
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
          throw avatarErr;
        }
      } catch (err) {
        console.error('Failed to update avatar:', err.message);
        return message.reply(`Could not update avatar: ${err.message}`);
      }
    }

    const normalizedContent = normalizePrefixCommand(message.content);
    const contentLower = normalizedContent.toLowerCase();

    // Help command: publicly available to all users (supports !help, !nhelp, help, nhelp)
    const isHelpCommand = contentLower === '!nhelp' || contentLower.startsWith('!nhelp ') ||
      contentLower === '!help' || contentLower.startsWith('!help ') ||
      contentLower === 'help' || contentLower === 'nhelp';

    if (isHelpCommand) {
      if (!isPrimaryInGuild) return;
      return sendAnimatedHelp(message, message.guild, client.user);
    }

    const playSongMatch = message.content.trim().match(/^!?\s*(?:playsong|ps)(?:\s+([\s\S]+))?$/i);
    if (playSongMatch) {
      if (!isPrimaryInGuild) return;
      const query = playSongMatch[1]?.trim();
      if (!query) {
        return message.reply('Usage: `!playsong <song or URL>` (alias: `!ps <song or URL>`)');
      }
      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) {
        return message.reply('Join a voice channel first to play a song.');
      }

      try {
        const result = await playSongWithLavalink({
          guildId: message.guild.id,
          voiceChannelId: voiceChannel.id,
          textChannelId: message.channel.id,
          query,
          requester: message.author,
        });
        const action = result.alreadyPlaying ? 'Queued' : 'Playing';
        return message.reply(`🎵 ${action}: **${result.title}**${result.queuedCount > 1 ? ` (+${result.queuedCount - 1} playlist tracks)` : ''}`);
      } catch (err) {
        console.error(`[Lavalink ${message.guild.id}] Song request failed: ${err.message}`);
        return message.reply(`Could not play that song: ${err.message}`);
      }
    }

    const isTagCommand = contentLower.startsWith('!ntag');
    const isClearCommand = contentLower === '!nclear' || contentLower.startsWith('!nclear ');
    const isShuffleCommand = contentLower.startsWith('!nshuffle') || contentLower.startsWith('!shuffle') || contentLower.startsWith('shuffle') || contentLower.startsWith('nshuffle');
    const isStopShuffleCommand = contentLower.startsWith('!nstopshuffle') || contentLower.startsWith('!stopshuffle') || contentLower.startsWith('stopshuffle') || contentLower === 'stop shuffle' || contentLower === '!stop shuffle' || contentLower === 'nstop shuffle' || contentLower === '!nstop shuffle';
    const isServerMuteCommand = contentLower.startsWith('!nservermute') || contentLower.startsWith('!servermute') || contentLower.startsWith('!nsmute') || contentLower.startsWith('!smute');
    const isServerUnmuteCommand = contentLower.startsWith('!nserverunmute') || contentLower.startsWith('!serverunmute') || contentLower.startsWith('!nsunmute') || contentLower.startsWith('!sunmute');
    const isMoveAllCommand = contentLower.startsWith('!nmoveall') || contentLower.startsWith('!moveall');
    const isPingCommand = contentLower === '!nping' || contentLower === 'ping';
    const isModCommand = contentLower === '!nmod' || contentLower === 'nmod' || contentLower === '!mod' || contentLower === 'mod';
    const joinMatch = contentLower.match(/^!njoin(\d+)$/);
    const isSingleJoinCommand = !!joinMatch;
    const isClearAllCommand = contentLower === '!nclearall';
    const isPlayCommand = contentLower === '!nplay' || contentLower.startsWith('!nplay ') ||
      contentLower === '!play' || contentLower.startsWith('!play ') ||
      contentLower === 'play' || contentLower.startsWith('play ') ||
      contentLower === 'nplay' || contentLower.startsWith('nplay ');
    const allowedCommands = ['!njoin', '!nplay', '!nleave', '!nstop', '!npleave', '!n700', '!n1000', '!ogvc'];
    if (allowedCommands.includes(contentLower) || isPlayCommand || isTagCommand || isClearCommand || isShuffleCommand || isStopShuffleCommand || isPingCommand || isModCommand || isSingleJoinCommand || isClearAllCommand || isServerMuteCommand || isServerUnmuteCommand || isMoveAllCommand) {
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
      const vc = message.member?.voice?.channel;
      const targetVcId = vc ? vc.id : (bot.channelId || defaultChannelId);
      if (!targetVcId) {
        if (isPrimaryInGuild) {
          return message.reply('Join a voice channel first to play audio.');
        }
        return;
      }

      if (isPrimaryInGuild) {
        await restoreRecordedVoiceForGuild(message.guild.id, targetVcId);
      }

      // Normal play command: ALL bots in this guild join VC if not already connected
      if (!connection || bot.channelId !== targetVcId) {
        bot.guildId = message.guild.id;
        bot.channelId = targetVcId;
        intentionalLeave = false;
        await joinChannel(message.guild.id, targetVcId);
      }

      // The primary responder triggers shared playback ONCE for all bots in this guild
      if (isPrimaryInGuild) {
        const mgr = getGuildAudioManager(message.guild.id);
        mgr.currentVolume = 10.0;
        playGuildAudio(message.guild.id, { volume: mgr.currentVolume, bassBoost: mgr.currentBassBoost });
        return message.reply(`Playing recorded audio across bots in sync (Volume: 1000%, Bass Boost: ${mgr.currentBassBoost ? 'ON' : 'OFF'}).`);
      }
      return;
    }

    // !nstop or !stop or stop
    if (contentLower === '!nstop' || contentLower === '!stop' || contentLower === 'stop' || contentLower === 'nstop') {
      if (isPrimaryInGuild) {
        stopGuildAudio(message.guild.id);
        return message.reply('Stopped audio playback across all bots.');
      }
      return;
    }

    // !nleave or !ogvc
    if (contentLower === '!nleave' || contentLower === '!ogvc') {
      bot.guildId = defaultGuildId;
      bot.channelId = defaultChannelId;
      intentionalLeave = false;
      joinChannel(defaultGuildId, defaultChannelId);

      if (isPrimaryInGuild) {
        stopGuildAudio(message.guild.id);
        return message.reply('Returning bots to the original voice channel.');
      }
      return;
    }

    // !npleave
    if (contentLower === '!npleave') {
      intentionalLeave = true;
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
        stopGuildAudio(message.guild.id);
        return message.reply('Left the voice channel permanently.');
      }
      return;
    }

    // !n700
    if (contentLower === '!n700') {
      const mgr = getGuildAudioManager(message.guild.id);
      mgr.currentVolume = 7.0;
      mgr.currentBassBoost = true;
      
      if (isPrimaryInGuild) {
        if (mgr.player.state.status === 'playing') {
          playGuildAudio(message.guild.id, { volume: 7.0, bassBoost: true });
          return message.reply('Volume boosted to 700% and Bass Boost enabled across all bots.');
        }
        return message.reply('Volume boosted to 700% and Bass Boost enabled for next playback.');
      }
      return;
    }

    // !n1000
    if (contentLower === '!n1000') {
      const mgr = getGuildAudioManager(message.guild.id);
      mgr.currentVolume = 10.0;
      mgr.currentBassBoost = true;
      mgr.isMutingEveryone = true;
      const vc = message.member?.voice?.channel;
      if (vc) muteAllGuildMembers(message.guild.id, vc.id);
      
      if (isPrimaryInGuild) {
        if (mgr.player.state.status === 'playing') {
          playGuildAudio(message.guild.id, { volume: 10.0, bassBoost: true });
          return message.reply('Volume boosted to 1000%, Bass Boost set to MAX, and VC muted to dominate.');
        }
        return message.reply('Volume boosted to 1000%, Bass Boost set to MAX, and VC muted to dominate.');
      }
      return;
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
  });

  if (!bot.token) {
    console.log('A bot token is missing in config.js');
    continue;
  }

  client.login(bot.token).catch(err => {
    console.warn(`[Bot ${currentActiveIndex + 1}] Login notice: ${err.message}`);
  });
}
