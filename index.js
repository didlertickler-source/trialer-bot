require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  Events,
  AuditLogEvent
} = require('discord.js');

const required = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'SOURCE_GUILD_ID',
  'TARGET_GUILD_ID',
  'TRIAL_RESULTS_CHANNEL_ID'
];

const missing = required.filter(key => !process.env[key]);

if (missing.length) {
  console.error(`Missing Railway variables: ${missing.join(', ')}`);
  process.exit(1);
}

const ranks = [
  '𓆩˙⸸˙𓆪︱top 1',
  '𓆩˙⸸˙𓆪︱top 3',
  '𓆩˙⸸˙𓆪︱top 15',
  '𓆩˙⸸˙𓆪︱best',
  '𓆩˙⸸˙𓆪︱starting xi',
  '𓆩˙⸸˙𓆪︱main bench',
  '𓆩˙⸸˙𓆪︱team A',
  '𓆩˙⸸˙𓆪︱team B',
  '𓆩˙⸸˙𓆪︱team C',
  '𓆩˙⸸˙𓆪︱team D'
];

const dataFile =
  process.env.DATA_FILE ||
  path.join(__dirname, 'data', 'state.json');

fs.mkdirSync(path.dirname(dataFile), { recursive: true });

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return {
      pending: data.pending || {},
      settings: data.settings || {}
    };
  } catch {
    return { pending: {}, settings: {} };
  }
}

const state = loadState();

function saveState() {
  const temp = `${dataFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, dataFile);
}

function norm(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function findRank(value) {
  const query = norm(value);

  if (!query) return { error: 'Enter a rank name.' };

  let matches = ranks.filter(rank => norm(rank) === query);

  if (matches.length === 1) return { rank: matches[0] };

  matches = ranks.filter(rank => norm(rank).includes(query));

  if (matches.length === 1) return { rank: matches[0] };

  return {
    error: matches.length
      ? 'Rank name is ambiguous. Enter a more specific name.'
      : `Unknown rank. Available ranks: ${ranks.join(', ')}`
  };
}

const isAdmin = member =>
  Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));

function toggleCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName('state')
        .setDescription('Enable or disable')
        .setRequired(true)
        .addChoices(
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' }
        )
    );
}

const commands = [
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Announce trial results and queue a rank.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName('user').setDescription('Player').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('role').setDescription('Rank name').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Check a player rank in the destination server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName('user').setDescription('Player').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('promote')
    .setDescription('Change a player rank in the destination server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName('user').setDescription('Player').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('rank').setDescription('New rank').setRequired(true)
    ),

  toggleCommand('antiraid', 'Toggle anti-raid protection.'),
  toggleCommand('antinuke', 'Toggle anti-nuke monitoring.'),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency.'),

  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Show server information.'),

  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Show user information.')
    .addUserOption(option =>
      option.setName('user').setDescription('User').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Show a user avatar.')
    .addUserOption(option =>
      option.setName('user').setDescription('User').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('roleinfo')
    .setDescription('Show role information.')
    .addRoleOption(option =>
      option.setName('role').setDescription('Role').setRequired(true)
    )
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const rest = new REST({ version: '10' })
  .setToken(process.env.DISCORD_TOKEN);

function getSettings(guildId) {
  if (!state.settings[guildId]) {
    state.settings[guildId] = {
      antiraid: false,
      antinuke: false
    };
  }

  return state.settings[guildId];
}

async function securityLog(guild, title, description, color = 0x252525) {
  try {
    const channelId =
      process.env.SECURITY_LOG_CHANNEL_ID ||
      process.env.RANK_LOG_CHANNEL_ID;

    if (!channelId) return;

    const channel = await guild.channels.fetch(channelId).catch(() => null);

    if (!channel?.isTextBased() || !channel.send) return;

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle(title)
          .setDescription(description)
          .setTimestamp()
      ]
    });
  } catch (error) {
    console.error('Security log error:', error.message);
  }
}

async function setExternalApps(guild, enabled) {
  let changed = 0;

  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites?.edit) continue;

    try {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { UseExternalApps: enabled ? false : null },
        { reason: `Anti-raid ${enabled ? 'enabled' : 'disabled'}` }
      );

      changed++;
    } catch (error) {
      console.error('External apps permission error:', error.message);
    }
  }

  return changed;
}

const messageHits = new Map();
const joinHits = new Map();
const auditHits = new Map();

client.once(Events.ClientReady, bot => {
  console.log(`Logged in as ${bot.user.tag}`);
  console.log('Rank, utility and security commands are loading.');
});

client.on(Events.MessageCreate, async message => {
  try {
    if (!message.guild || message.author.bot) return;

    const content = message.content.trim().toLowerCase();

    // Prefix commands: administrators only.
    if (
      ['?ping', '?membercount', '?whosflorian'].includes(content)
    ) {
      if (!isAdmin(message.member)) {
        return message.reply('Administrator permission is required.')
          .catch(() => {});
      }

      if (content === '?ping') {
        return message.reply(
          `Pong! **${client.ws.ping}ms**`
        ).catch(() => {});
      }

      if (content === '?whosflorian') {
        return message.reply('de goat').catch(() => {});
      }

      const guild = await client.guilds
        .fetch(process.env.TARGET_GUILD_ID)
        .catch(() => null);

      if (!guild) {
        return message.reply('Cannot access the destination server.')
          .catch(() => {});
      }

      const fullGuild = await guild.fetch().catch(() => null);

      return message.reply(
        `**${fullGuild?.name || guild.name}** has **${(
          fullGuild?.memberCount ?? guild.memberCount ?? 0
        ).toLocaleString()}** members.`
      ).catch(() => {});
    }

    if (!getSettings(message.guild.id).antiraid) return;

    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();

    const hits = (messageHits.get(key) || [])
      .filter(time => now - time < 6000);

    hits.push(now);
    messageHits.set(key, hits);

    if (hits.length >= 6) {
      const member = await message.guild.members
        .fetch(message.author.id)
        .catch(() => null);

      if (member && !isAdmin(member) && member.moderatable) {
        await member.timeout(
          60000,
          'Anti-raid: rapid message spam'
        ).catch(error => {
          console.error('Timeout error:', error.message);
        });

        await securityLog(
          message.guild,
          'Anti-Raid: Spam Detected',
          `${message.author} triggered the message-spam threshold.`,
          0xe67e22
        );

        messageHits.delete(key);
      }
    }
  } catch (error) {
    console.error('Message handler error:', error);
  }
});

async function monitorDestructiveAction(guild, type, label) {
  if (!getSettings(guild.id).antinuke) return;

  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 1 });
    const entry = logs.entries.first();

    if (
      !entry ||
      Date.now() - entry.createdTimestamp > 15000 ||
      !entry.executor ||
      entry.executor.id === client.user.id ||
      entry.executor.id === guild.ownerId
    ) {
      return;
    }

    const key = `${guild.id}:${entry.executor.id}`;
    const now = Date.now();

    const hits = (auditHits.get(key) || [])
      .filter(time => now - time < 30000);

    hits.push(now);
    auditHits.set(key, hits);

    await securityLog(
      guild,
      'Anti-Nuke Alert',
      `**Action:** ${label}\n**Actor:** ${entry.executor} (\`${entry.executor.id}\`)\n**Recent monitored actions:** ${hits.length}`,
      0xe74c3c
    );

    if (hits.length < 2) return;

    const member = await guild.members
      .fetch(entry.executor.id)
      .catch(() => null);

    if (!member?.manageable) return;

    const dangerous = [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageWebhooks,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.BanMembers
    ];

    for (const role of member.roles.cache.values()) {
      if (
        role.managed ||
        role.id === guild.id ||
        !role.permissions.any(dangerous)
      ) {
        continue;
      }

      await member.roles.remove(
        role,
        'Anti-nuke: repeated destructive actions'
      ).catch(error => {
        console.error('Role removal error:', error.message);
      });
    }

    await securityLog(
      guild,
      'Anti-Nuke Response',
      `Attempted to remove manageable dangerous roles from ${entry.executor}.`,
      0xc0392b
    );
  } catch (error) {
    console.error('Anti-nuke monitoring error:', error);
  }
}

client.on(Events.ChannelDelete, channel => {
  if (channel.guild) {
    void monitorDestructiveAction(
      channel.guild,
      AuditLogEvent.ChannelDelete,
      `Deleted channel: ${channel.name}`
    );
  }
});

client.on(Events.RoleDelete, role => {
  void monitorDestructiveAction(
    role.guild,
    AuditLogEvent.RoleDelete,
    `Deleted role: ${role.name}`
  );
});

client.on(Events.WebhooksUpdate, channel => {
  void monitorDestructiveAction(
    channel.guild,
    AuditLogEvent.WebhookUpdate,
    `Webhook changed in #${channel.name}`
  );
});

client.on(Events.GuildMemberAdd, async member => {
  try {
    const pending = state.pending[member.id];

    if (
      member.guild.id === process.env.TARGET_GUILD_ID &&
      pending
    ) {
      const role =
        member.guild.roles.cache.get(pending.roleId) ||
        member.guild.roles.cache.find(
          item => norm(item.name) === norm(pending.rankName)
        );

      if (role && !role.managed && role.id !== member.guild.id) {
        const botMember = await member.guild.members.fetchMe();

        if (
          botMember.permissions.has(PermissionFlagsBits.ManageRoles) &&
          botMember.roles.highest.comparePositionTo(role) > 0
        ) {
          await member.roles.add(role, 'Pending trial rank');

          delete state.pending[member.id];
          saveState();

          await member.send(
            `Your rank has been applied: **${role.name}**.`
          ).catch(() => {});
        }
      }
    }

    if (member.user.bot) {
      void monitorDestructiveAction(
        member.guild,
        AuditLogEvent.BotAdd,
        `Added bot: ${member.user.tag}`
      );
    }

    if (!getSettings(member.guild.id).antiraid) return;

    const now = Date.now();

    const hits = (joinHits.get(member.guild.id) || [])
      .filter(time => now - time < 15000);

    hits.push(now);
    joinHits.set(member.guild.id, hits);

    if (hits.length === 8) {
      await securityLog(
        member.guild,
        'Anti-Raid: Join Burst',
        'Eight members joined within 15 seconds. Check the join list and Discord Raid Protection.',
        0xe67e22
      );
    }
  } catch (error) {
    console.error('Member join handler error:', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const name = interaction.commandName;

    const adminCommands = [
      'rank',
      'check',
      'promote',
      'antiraid',
      'antinuke'
    ];

    if (
      adminCommands.includes(name) &&
      (!interaction.inGuild() || !isAdmin(interaction.member))
    ) {
      return interaction.reply({
        content: 'Administrator permission is required.',
        ephemeral: true
      });
    }

    // /ping
    if (name === 'ping') {
      return interaction.reply({
        content: `Pong! **${client.ws.ping}ms**`,
        ephemeral: true
      });
    }

    // /serverinfo
    if (name === 'serverinfo') {
      if (!interaction.guild) {
        return interaction.reply({
          content: 'Use this command in a server.',
          ephemeral: true
        });
      }

      const guild = await interaction.guild.fetch();

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x252525)
            .setTitle(guild.name)
            .setThumbnail(guild.iconURL())
            .setDescription(
              `**Members:** ${guild.memberCount}\n` +
              `**Owner ID:** ${guild.ownerId}\n` +
              `**Channels:** ${guild.channels.cache.size}\n` +
              `**Roles:** ${guild.roles.cache.size}\n` +
              `**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`
            )
        ],
        ephemeral: true
      });
    }

    // /userinfo
    if (name === 'userinfo') {
      const user =
        interaction.options.getUser('user') || interaction.user;

      const member = interaction.guild
        ? await interaction.guild.members.fetch(user.id).catch(() => null)
        : null;

      const roles = member
        ? member.roles.cache
            .filter(role => role.id !== interaction.guild.id)
            .map(role => role.name)
            .join(', ') || 'None'
        : 'Unavailable';

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x252525)
            .setTitle('User Information')
            .setThumbnail(user.displayAvatarURL())
            .setDescription(
              `**User:** ${user}\n` +
              `**ID:** \`${user.id}\`\n` +
              `**Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:F>\n` +
              `**Joined:** ${member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : 'Not in this server'}\n` +
              `**Roles:** ${roles}`
            )
        ],
        ephemeral: true
      });
    }

    // /avatar
    if (name === 'avatar') {
      const user =
        interaction.options.getUser('user') || interaction.user;

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x252525)
            .setTitle(`${user.username}'s Avatar`)
            .setImage(user.displayAvatarURL({ size: 1024 }))
        ],
        ephemeral: true
      });
    }

    // /roleinfo
    if (name === 'roleinfo') {
      const role = interaction.options.getRole('role', true);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(role.color || 0x252525)
            .setTitle('Role Information')
            .setDescription(
              `**Role:** ${role}\n` +
              `**ID:** \`${role.id}\`\n` +
              `**Members:** ${role.members.size}\n` +
              `**Position:** ${role.position}\n` +
              `**Mentionable:** ${role.mentionable ? 'Yes' : 'No'}`
            )
        ],
        ephemeral: true
      });
    }

    // /antiraid on|off and /antinuke on|off
    if (name === 'antiraid' || name === 'antinuke') {
      const enabled =
        interaction.options.getString('state') === 'on';

      const settings = getSettings(interaction.guild.id);
      settings[name] = enabled;
      saveState();

      let extra = '';

      if (name === 'antiraid') {
        if (enabled) {
          const count = await setExternalApps(interaction.guild, true);
          extra = ` External Apps denied in ${count} accessible channels.`;
        } else {
          await setExternalApps(interaction.guild, false);
        }
      }

      await securityLog(
        interaction.guild,
        `${name} Configuration`,
        `**Changed by:** ${interaction.user}\n**Status:** ${enabled ? 'Enabled' : 'Disabled'}${extra}`,
        enabled ? 0x2ecc71 : 0x95a5a6
      );

      return interaction.reply({
        content: `**${name} ${enabled ? 'enabled' : 'disabled'}.**${extra}`,
        ephemeral: true
      });
    }

    // /check
    if (name === 'check') {
      await interaction.deferReply({ ephemeral: true });

      const user = interaction.options.getUser('user', true);

      const guild = await client.guilds
        .fetch(process.env.TARGET_GUILD_ID)
        .catch(() => null);

      if (!guild) {
        return interaction.editReply(
          'Cannot access the destination server.'
        );
      }

      const member = await guild.members
        .fetch(user.id)
        .catch(() => null);

      if (!member) {
        return interaction.editReply(
          'That player is not in the destination server.'
        );
      }

      const found = member.roles.cache
        .filter(role =>
          ranks.some(rank => norm(rank) === norm(role.name))
        )
        .map(role => role.name);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x252525)
            .setTitle('Rank Check')
            .setThumbnail(user.displayAvatarURL())
            .setDescription(
              `**Player:** ${user}\n` +
              `**Server:** ${guild.name}\n` +
              `**Rank:** ${found.join(', ') || 'Unranked'}`
            )
        ]
      });
    }

    // /promote
    if (name === 'promote') {
      await interaction.deferReply({ ephemeral: true });

      const user = interaction.options.getUser('user', true);
      const result = findRank(
        interaction.options.getString('rank', true)
      );

      if (result.error) return interaction.editReply(result.error);

      const guild = await client.guilds
        .fetch(process.env.TARGET_GUILD_ID)
        .catch(() => null);

      if (!guild) {
        return interaction.editReply(
          'Cannot access the destination server.'
        );
      }

      const member = await guild.members
        .fetch(user.id)
        .catch(() => null);

      if (!member) {
        return interaction.editReply(
          'That player is not in the destination server.'
        );
      }

      const role = guild.roles.cache.find(
        item => norm(item.name) === norm(result.rank)
      );

      if (!role || role.managed || role.id === guild.id) {
        return interaction.editReply(
          'Create that rank role first in the destination server.'
        );
      }

      const botMember = await guild.members.fetchMe();

      if (
        !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
        botMember.roles.highest.comparePositionTo(role) <= 0
      ) {
        return interaction.editReply(
          'Check Manage Roles permission and bot role hierarchy.'
        );
      }

      const oldRoles = member.roles.cache.filter(role =>
        ranks.some(rank => norm(rank) === norm(role.name))
      );

      try {
        if (oldRoles.size) {
          await member.roles.remove([...oldRoles.values()]);
        }

        await member.roles.add(
          role,
          `Promoted by ${interaction.user.tag}`
        );
      } catch (error) {
        console.error('Promotion error:', error);

        return interaction.editReply(
          'Promotion failed. Check permissions and role hierarchy.'
        );
      }

      const description =
        `**Player:** ${user}\n` +
        `**Previous rank:** ${oldRoles.map(role => role.name).join(', ') || 'Unranked'}\n` +
        `**New rank:** ${role.name}\n` +
        `**By:** ${interaction.user}`;

      await securityLog(guild, 'Rank Promotion Log', description);

      await user.send(
        `You've been promoted to **${role.name}** in **${guild.name}**.`
      ).catch(() => {});

      return interaction.editReply({
        content: `Promoted ${user} to **${role.name}**.`,
        embeds: [
          new EmbedBuilder()
            .setColor(0x252525)
            .setTitle('Rank Promotion Log')
            .setDescription(description)
            .setTimestamp()
        ]
      });
    }

    // /rank
    if (name === 'rank') {
      if (interaction.guildId !== process.env.SOURCE_GUILD_ID) {
        return interaction.reply({
          content: 'Use this command in the source server.',
          ephemeral: true
        });
      }

      const user = interaction.options.getUser('user', true);
      const result = findRank(
        interaction.options.getString('role', true)
      );

      if (result.error) {
        return interaction.reply({
          content: result.error,
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const source = interaction.guild;

      const target = await client.guilds
        .fetch(process.env.TARGET_GUILD_ID)
        .catch(() => null);

      if (!target) {
        return interaction.editReply(
          'Cannot access the destination server.'
        );
      }

      if (source.id === target.id) {
        return interaction.editReply(
          'Source and destination servers must be different.'
        );
      }

      const channel = await source.channels
        .fetch(process.env.TRIAL_RESULTS_CHANNEL_ID)
        .catch(() => null);

      if (!channel?.isTextBased() || !channel.send) {
        return interaction.editReply(
          'Cannot find the trial-results text channel.'
        );
      }

      const member = await source.members
        .fetch(user.id)
        .catch(() => null);

      if (!member) {
        return interaction.editReply(
          'Player is not in the source server.'
        );
      }

      if (user.id === interaction.user.id || user.id === source.ownerId) {
        return interaction.editReply(
          'You cannot rank-kick yourself or the server owner.'
        );
      }

      const role = target.roles.cache.find(
        item => norm(item.name) === norm(result.rank)
      );

      if (!role || role.managed || role.id === target.id) {
        return interaction.editReply(
          'Create that rank role in the destination server first.'
        );
      }

      const sourceBot = source.members.me;
      const targetBot = await target.members.fetchMe();

      if (
        !sourceBot?.permissions.has(PermissionFlagsBits.KickMembers) ||
        member.roles.highest.comparePositionTo(sourceBot.roles.highest) >= 0
      ) {
        return interaction.editReply(
          'Check Kick Members permission and source role hierarchy.'
        );
      }

      if (
        !targetBot.permissions.has(PermissionFlagsBits.ManageRoles) ||
        targetBot.roles.highest.comparePositionTo(role) <= 0
      ) {
        return interaction.editReply(
          'Check Manage Roles permission and destination role hierarchy.'
        );
      }

      state.pending[user.id] = {
        rankName: role.name,
        roleId: role.id,
        createdAt: Date.now()
      };

      saveState();

      let dmSent = true;

      try {
        const invite = process.env.TARGET_INVITE_URL;

        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x252525)
              .setTitle('Rank Update')
              .setDescription(
                `You've been ranked to **${role.name}**.` +
                (invite
                  ? `\n\nJoin the ranking server to receive your role:\n${invite}`
                  : '\n\nJoin the ranking server to receive your role.')
              )
          ]
        });
      } catch {
        dmSent = false;
      }

      try {
        await channel.send({
          content: user.toString(),
          allowedMentions: { users: [user.id] },
          embeds: [
            new EmbedBuilder()
              .setColor(0x252525)
              .setTitle('Trial Results')
              .setDescription(
                `**Player:** ${user}\n` +
                `**Decision:** Successfully ranked\n` +
                `**New Rank:** ${role.name}\n` +
                `**Issued by:** ${interaction.user}\n\n` +
                '*Join the ranking server to receive your role.*'
              )
              .setTimestamp()
          ]
        });
      } catch (error) {
        console.error('Trial results error:', error);

        delete state.pending[user.id];
        saveState();

        return interaction.editReply(
          'Could not post trial results. The player was not kicked.'
        );
      }

      try {
        await member.kick(`Ranked to ${role.name}`);
      } catch (error) {
        console.error('Kick error:', error);

        return interaction.editReply(
          'Results posted, but kicking failed. Check permissions and hierarchy.'
        );
      }

      return interaction.editReply(
        `Done. Results posted, DM ${dmSent ? 'sent' : 'blocked'}, and player kicked from the source server. Their rank is queued for the destination server.`
      );
    }
  } catch (error) {
    console.error(`Command ${interaction.commandName} failed:`, error);

    const response = {
      content: 'Command failed. Check the Railway deployment logs.',
      ephemeral: true
    };

    if (interaction.deferred) {
      return interaction.editReply(response).catch(() => {});
    }

    if (interaction.replied) {
      return interaction.followUp(response).catch(() => {});
    }

    return interaction.reply(response).catch(() => {});
  }
});

async function start() {
  console.log('Registering slash commands...');

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.SOURCE_GUILD_ID
    ),
    { body: commands.map(command => command.toJSON()) }
  );

  console.log('Slash commands registered.');
  await client.login(process.env.DISCORD_TOKEN);
}

process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
});

start().catch(error => {
  console.error('Startup failed:', error);
  process.exit(1);
});
