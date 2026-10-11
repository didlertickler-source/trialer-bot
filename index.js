
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
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
} = require("discord.js");

for (const key of [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "SOURCE_GUILD_ID",
  "TARGET_GUILD_ID",
  "TRIAL_RESULTS_CHANNEL_ID",
  "TARGET_INVITE_URL"
]) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}

const SOURCE_GUILD_ID = process.env.SOURCE_GUILD_ID;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;
const TRIAL_RESULTS_CHANNEL_ID = process.env.TRIAL_RESULTS_CHANNEL_ID;
const TARGET_INVITE_URL = process.env.TARGET_INVITE_URL;

const RANKS = [
  "𓆩˙⸸˙𓆪︱top 1",
  "𓆩˙⸸˙𓆪︱top 3",
  "𓆩˙⸸˙𓆪︱top 15",
  "𓆩˙⸸˙𓆪︱best",
  "𓆩˙⸸˙𓆪︱starting xi",
  "𓆩˙⸸˙𓆪︱main bench",
  "𓆩˙⸸˙𓆪︱team A",
  "𓆩˙⸸˙𓆪︱team B",
  "𓆩˙⸸˙𓆪︱team C",
  "𓆩˙⸸˙𓆪︱team D"
];

const DATA_FILE =
  process.env.DATA_FILE ||
  path.join(__dirname, "data", "state.json");

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { pending: {}, settings: {} };
  }
}

const data = loadData();

data.pending ||= {};
data.settings ||= {};

function saveData() {
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, DATA_FILE);
}

const normalize = value =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function findRank(input) {
  const query = normalize(input);

  if (!query) return { error: "Enter a rank name." };

  const exact = RANKS.filter(rank => normalize(rank) === query);

  if (exact.length === 1) return { rank: exact[0] };

  const matches = RANKS.filter(rank => normalize(rank).includes(query));

  if (matches.length === 1) return { rank: matches[0] };

  if (matches.length > 1) {
    return {
      error:
        "That rank is ambiguous. Try one of these: " +
        matches.map(rank => `\`${rank}\``).join(", ")
    };
  }

  return {
    error:
      "Rank not found. Available ranks: " +
      RANKS.map(rank => `\`${rank}\``).join(", ")
  };
}

const COLORS = {
  main: 0x252525,
  success: 0x57f287,
  error: 0xed4245,
  warning: 0xfee75c,
  info: 0x5865f2
};

function makeEmbed(title, description, color = COLORS.main) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description || "No additional information.")
    .setTimestamp()
    .setFooter({ text: "Server Management" });
}

function isAdmin(member) {
  return Boolean(
    member?.permissions?.has(PermissionFlagsBits.Administrator)
  );
}

function getSettings(guildId) {
  if (!data.settings[guildId]) {
    data.settings[guildId] = {
      antiraid: false,
      antinuke: false
    };
  }

  return data.settings[guildId];
}

async function getGuild(id) {
  return client.guilds.cache.get(id) ||
    await client.guilds.fetch(id).catch(() => null);
}

async function sendLog(guild, title, description, color = COLORS.warning) {
  if (!guild) return;

  const channelId =
    process.env.SECURITY_LOG_CHANNEL_ID ||
    process.env.RANK_LOG_CHANNEL_ID;

  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);

  if (!channel?.isTextBased()) return;

  await channel.send({
    embeds: [makeEmbed(title, description, color)]
  }).catch(error => console.error("Log error:", error.message));
}

async function sendDM(user, title, description, color = COLORS.info) {
  try {
    await user.send({
      embeds: [makeEmbed(title, description, color)]
    });
    return true;
  } catch {
    return false;
  }
}

async function getResultsChannel(guild) {
  const channel = await guild.channels
    .fetch(TRIAL_RESULTS_CHANNEL_ID)
    .catch(() => null);

  if (!channel?.isTextBased() || !channel.send) return null;

  return channel;
}

async function postRankResult({
  guild,
  player,
  rank,
  issuer
}) {
  const channel = await getResultsChannel(guild);

  if (!channel) {
    await sendLog(
      guild,
      "Trial Results Failed",
      `Could not access the configured trial-results channel.\nChannel ID: ${TRIAL_RESULTS_CHANNEL_ID}`,
      COLORS.error
    );

    return false;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle("Trial Results")
    .setDescription(
      `**${player.username} has been ranked to ${rank.name} by ${issuer.username}.**`
    )
    .addFields(
      {
        name: "Player",
        value: `${player}`,
        inline: true
      },
      {
        name: "New Rank",
        value: rank.name,
        inline: true
      },
      {
        name: "Ranked By",
        value: `${issuer}`,
        inline: true
      }
    )
    .setThumbnail(player.displayAvatarURL({ size: 256 }))
    .setFooter({ text: "Trial Department" })
    .setTimestamp();

  try {
    await channel.send({
      content: `${player}`,
      embeds: [embed],
      allowedMentions: {
        users: [player.id]
      }
    });

    return true;
  } catch (error) {
    console.error("Trial results error:", error.message);

    await sendLog(
      guild,
      "Trial Results Failed",
      `Player: ${player.tag}\nError: ${error.message}`,
      COLORS.error
    );

    return false;
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const rest = new REST({ version: "10" }).setToken(
  process.env.DISCORD_TOKEN
);

function toggleCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("state")
        .setDescription("Protection state")
        .setRequired(true)
        .addChoices(
          { name: "On", value: "on" },
          { name: "Off", value: "off" }
        )
    );
}

const commands = [
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Rank a player, announce the result and kick them.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName("user").setDescription("Player to rank").setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("role")
        .setDescription("Rank name; symbols are optional")
        .setRequired(true)
        .setMaxLength(80)
    ),

  new SlashCommandBuilder()
    .setName("promote")
    .setDescription("Change a player's rank in the destination server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName("user").setDescription("Player to promote").setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("rank")
        .setDescription("New rank name")
        .setRequired(true)
        .setMaxLength(80)
    ),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Check a player's rank.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName("user").setDescription("Player to check").setRequired(true)
    ),

  toggleCommand("antiraid", "Toggle anti-raid protection."),
  toggleCommand("antinuke", "Toggle anti-nuke monitoring"),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot latency."),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Show server information."),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Show information about a user.")
    .addUserOption(option =>
      option.setName("user").setDescription("User to inspect").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a user's avatar.")
    .addUserOption(option =>
      option.setName("user").setDescription("User to inspect").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("Show information about a role.")
    .addRoleOption(option =>
      option.setName("role").setDescription("Role to inspect").setRequired(true)
    )
];

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      SOURCE_GUILD_ID
    ),
    {
      body: commands.map(command => command.toJSON())
    }
  );

  console.log("Slash commands registered.");
}

async function externalApps(guild, enabled) {
  let changed = 0;

  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites?.edit) continue;

    try {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { UseExternalApps: enabled ? false : null },
        { reason: `Anti-raid ${enabled ? "enabled" : "disabled"}` }
      );

      changed++;
    } catch (error) {
      console.error("External apps permission error:", error.message);
    }
  }

  return changed;
}

const messageHits = new Map();
const joinHits = new Map();
const auditHits = new Map();

async function handleAntiNuke(guild, type, description) {
  if (!getSettings(guild.id).antinuke) return;

  try {
    const audit = await guild.fetchAuditLogs({ type, limit: 1 });
    const entry = audit.entries.first();

    if (
      !entry ||
      Date.now() - entry.createdTimestamp > 12000 ||
      !entry.executor ||
      entry.executor.id === client.user.id ||
      entry.executor.id === guild.ownerId
    ) {
      return;
    }

    const key = `${guild.id}:${entry.executor.id}`;
    const now = Date.now();
    const recent = (auditHits.get(key) || [])
      .filter(time => now - time < 30000);

    recent.push(now);
    auditHits.set(key, recent);

    await sendLog(
      guild,
      "Anti-Nuke Alert",
      `**Action:** ${description}\n**Actor:** ${entry.executor} (\`${entry.executor.id}\`)\n**Recent monitored actions:** ${recent.length}`,
      COLORS.error
    );

    if (recent.length < 2) return;

    const member = await guild.members
      .fetch(entry.executor.id)
      .catch(() => null);

    if (!member?.manageable) return;

    const dangerousPermissions = [
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
        !role.permissions.any(dangerousPermissions)
      ) {
        continue;
      }

      await member.roles.remove(
        role,
        "Anti-nuke: repeated destructive actions"
      ).catch(error => console.error("Role removal failed:", error.message));
    }

    await sendLog(
      guild,
      "Anti-Nuke Response",
      `Attempted to remove dangerous permissions from ${entry.executor}.`,
      COLORS.error
    );
  } catch (error) {
    console.error("Anti-nuke audit error:", error.message);
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  readyClient.user.setActivity("Server Management");

  try {
    await registerCommands();
  } catch (error) {
    console.error("Command registration failed:", error);
  }
});

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;

  const content = message.content.trim().toLowerCase();

  if (content.startsWith("?")) {
    const command = content.split(/\s+/)[0];

    if (["?ping", "?membercount", "?whosflorian"].includes(command)) {
      if (!isAdmin(message.member)) {
        return message.reply({
          embeds: [
            makeEmbed(
              "Access Denied",
              "Administrator permission is required.",
              COLORS.error
            )
          ]
        }).catch(() => null);
      }

      if (command === "?ping") {
        return message.reply({
          embeds: [
            makeEmbed(
              "Pong",
              `Websocket latency: **${Math.round(client.ws.ping)}ms**`,
              COLORS.success
            )
          ]
        }).catch(() => null);
      }

      if (command === "?whosflorian") {
        return message.reply({
          embeds: [
            makeEmbed("Who's Florian?", "de goat", COLORS.info)
          ]
        }).catch(() => null);
      }

      if (command === "?membercount") {
        const guild = await getGuild(TARGET_GUILD_ID);

        if (!guild) {
          return message.reply({
            embeds: [
              makeEmbed(
                "Error",
                "Cannot access the destination server.",
                COLORS.error
              )
            ]
          }).catch(() => null);
        }

        const fetched = await guild.fetch().catch(() => null);

        return message.reply({
          embeds: [
            makeEmbed(
              "Member Count",
              `**${fetched?.name || guild.name}** has **${(
                fetched?.memberCount ??
                guild.memberCount ??
                0
              ).toLocaleString()}** members.`,
              COLORS.info
            )
          ]
        }).catch(() => null);
      }
    }
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
      await member.timeout(60000, "Anti-raid message spam")
        .catch(() => null);

      await sendLog(
        message.guild,
        "Anti-Raid: Spam",
        `${message.author} was timed out for 60 seconds after rapid messaging.`,
        COLORS.warning
      );

      messageHits.delete(key);
    }
  }
});

client.on(Events.ChannelDelete, channel => {
  if (channel.guild) {
    handleAntiNuke(
      channel.guild,
      AuditLogEvent.ChannelDelete,
      `Deleted channel: ${channel.name}`
    );
  }
});

client.on(Events.RoleDelete, role => {
  handleAntiNuke(
    role.guild,
    AuditLogEvent.RoleDelete,
    `Deleted role: ${role.name}`
  );
});

client.on(Events.WebhooksUpdate, channel => {
  handleAntiNuke(
    channel.guild,
    AuditLogEvent.WebhookCreate,
    `Webhook update in #${channel.name}`
  );
});

client.on(Events.GuildMemberAdd, async member => {
  if (member.guild.id === TARGET_GUILD_ID) {
    const pending = data.pending[member.id];

    if (pending) {
      const role =
        member.guild.roles.cache.get(pending.roleId) ||
        member.guild.roles.cache.find(
          candidate => normalize(candidate.name) === normalize(pending.rankName)
        );

      if (role && !role.managed && role.id !== member.guild.id) {
        const botMember = await member.guild.members.fetchMe();

        if (
          botMember.permissions.has(PermissionFlagsBits.ManageRoles) &&
          botMember.roles.highest.comparePositionTo(role) > 0
        ) {
          try {
            await member.roles.add(role, "Pending trial rank");

            delete data.pending[member.id];
            saveData();

            await sendDM(
              member.user,
              "Rank Applied",
              `Your rank has been applied: **${role.name}**.`,
              COLORS.success
            );

            console.log(`Applied ${role.name} to ${member.user.tag}.`);
          } catch (error) {
            console.error("Pending rank failed:", error.message);
          }
        }
      }
    }
  }

  if (member.user.bot) {
    handleAntiNuke(
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
    await sendLog(
      member.guild,
      "Anti-Raid: Join Burst",
      "Eight members joined within 15 seconds. Review the join list and Discord Raid Protection.",
      COLORS.warning
    );
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;

  if (
    ["rank", "check", "promote", "antiraid", "antinuke"].includes(name) &&
    (!interaction.inGuild() || !isAdmin(interaction.member))
  ) {
    return interaction.reply({
      embeds: [
        makeEmbed(
          "Access Denied",
          "Administrator permission is required.",
          COLORS.error
        )
      ],
      ephemeral: true
    });
  }

  if (name === "ping") {
    return interaction.reply({
      embeds: [
        makeEmbed(
          "Pong",
          `Websocket latency: **${Math.round(client.ws.ping)}ms**`,
          COLORS.success
        )
      ],
      ephemeral: true
    });
  }

  if (name === "serverinfo") {
    if (!interaction.guild) {
      return interaction.reply({
        embeds: [makeEmbed("Error", "Use this command in a server.", COLORS.error)],
        ephemeral: true
      });
    }

    const guild = await interaction.guild.fetch();

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.main)
          .setTitle(guild.name)
          .setThumbnail(guild.iconURL())
          .setDescription(
            `**Members:** ${guild.memberCount}\n` +
            `**Owner ID:** ${guild.ownerId}\n` +
            `**Channels:** ${guild.channels.cache.size}\n` +
            `**Roles:** ${guild.roles.cache.size}\n` +
            `**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`
          )
          .setTimestamp()
      ],
      ephemeral: true
    });
  }

  if (name === "userinfo") {
    const user = interaction.options.getUser("user") || interaction.user;
    const member = interaction.guild
      ? await interaction.guild.members.fetch(user.id).catch(() => null)
      : null;

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.main)
          .setTitle("User Information")
          .setThumbnail(user.displayAvatarURL())
          .setDescription(
            `**User:** ${user}\n` +
            `**ID:** \`${user.id}\`\n` +
            `**Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:F>\n` +
            `**Joined:** ${member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : "Not in this server"}\n` +
            `**Roles:** ${member ? member.roles.cache.filter(role => role.id !== interaction.guild.id).map(role => role.name).join(", ") || "None" : "Unavailable"}`
          )
          .setTimestamp()
      ],
      ephemeral: true
    });
  }

  if (name === "avatar") {
    const user = interaction.options.getUser("user") || interaction.user;

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.main)
          .setTitle(`${user.username}'s Avatar`)
          .setImage(user.displayAvatarURL({ size: 1024 }))
          .setTimestamp()
      ],
      ephemeral: true
    });
  }

  if (name === "roleinfo") {
    const role = interaction.options.getRole("role", true);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(role.color || COLORS.main)
          .setTitle("Role Information")
          .setDescription(
            `**Role:** ${role}\n` +
            `**ID:** \`${role.id}\`\n` +
            `**Members:** ${role.members.size}\n` +
            `**Position:** ${role.position}\n` +
            `**Mentionable:** ${role.mentionable ? "Yes" : "No"}`
          )
          .setTimestamp()
      ],
      ephemeral: true
    });
  }

  if (name === "antiraid" || name === "antinuke") {
    const enabled = interaction.options.getString("state") === "on";
    const settings = getSettings(interaction.guild.id);

    settings[name] = enabled;
    saveData();

    let extra = "";

    if (name === "antiraid") {
      if (enabled) {
        const count = await externalApps(interaction.guild, true);
        extra = ` External Apps denied in ${count} accessible channels.`;
      } else {
        await externalApps(interaction.guild, false);
      }
    }

    await sendLog(
      interaction.guild,
      `${name} Configuration`,
      `**By:** ${interaction.user}\n**Status:** ${enabled ? "Enabled" : "Disabled"}${extra}`,
      enabled ? COLORS.success : COLORS.warning
    );

    return interaction.reply({
      embeds: [
        makeEmbed(
          `${name} ${enabled ? "Enabled" : "Disabled"}`,
          `Protection is now **${enabled ? "enabled" : "disabled"}**.${extra}`,
          enabled ? COLORS.success : COLORS.warning
        )
      ],
      ephemeral: true
    });
  }

  if (name === "check") {
    await interaction.deferReply({ ephemeral: true });

    const user = interaction.options.getUser("user", true);
    const guild = await getGuild(TARGET_GUILD_ID);

    if (!guild) {
      return interaction.editReply({
        embeds: [makeEmbed("Error", "Cannot access destination server.", COLORS.error)]
      });
    }

    const member = await guild.members.fetch(user.id).catch(() => null);

    if (!member) {
      return interaction.editReply({
        embeds: [makeEmbed("Rank Check", "That player is not in the destination server.", COLORS.warning)]
      });
    }

    const found = member.roles.cache
      .filter(role => RANKS.some(rank => normalize(rank) === normalize(role.name)))
      .map(role => role.name);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.main)
          .setTitle("Rank Check")
          .setThumbnail(user.displayAvatarURL())
          .setDescription(
            `**Player:** ${user}\n` +
            `**Server:** ${guild.name}\n` +
            `**Rank:** ${found.join(", ") || "Unranked"}`
          )
          .setTimestamp()
      ]
    });
  }

  if (name === "promote") {
    await interaction.deferReply({ ephemeral: true });

    const user = interaction.options.getUser("user", true);
    const match = findRank(interaction.options.getString("rank", true));

    if (match.error) {
      return interaction.editReply({
        embeds: [makeEmbed("Invalid Rank", match.error, COLORS.error)]
      });
    }

    const guild = await getGuild(TARGET_GUILD_ID);

    if (!guild) {
      return interaction.editReply({
        embeds: [makeEmbed("Error", "Cannot access destination server.", COLORS.error)]
      });
    }

    const member = await guild.members.fetch(user.id).catch(() => null);

    if (!member) {
      return interaction.editReply({
        embeds: [makeEmbed("Player Not Found", "That player is not in the destination server.", COLORS.warning)]
      });
    }

    const role = guild.roles.cache.find(
      candidate => normalize(candidate.name) === normalize(match.rank)
    );

    if (!role || role.managed || role.id === guild.id) {
      return interaction.editReply({
        embeds: [makeEmbed("Rank Not Found", `Create the rank role first:\n${match.rank}`, COLORS.error)]
      });
    }

    const botMember = await guild.members.fetchMe();

    if (
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      botMember.roles.highest.comparePositionTo(role) <= 0
    ) {
      return interaction.editReply({
        embeds: [makeEmbed("Permission Error", "Give the bot Manage Roles and move its highest role above the requested rank.", COLORS.error)]
      });
    }

    const oldRoles = member.roles.cache.filter(existing =>
      RANKS.some(rank => normalize(rank) === normalize(existing.name))
    );

    try {
      if (oldRoles.size) {
        await member.roles.remove([...oldRoles.values()], `Promoted by ${interaction.user.tag}`);
      }

      await member.roles.add(role, `Promoted by ${interaction.user.tag}`);
    } catch (error) {
      return interaction.editReply({
        embeds: [makeEmbed("Promotion Failed", error.message, COLORS.error)]
      });
    }

    const description =
      `**Player:** ${user}\n` +
      `**Previous Rank:** ${oldRoles.map(existing => existing.name).join(", ") || "Unranked"}\n` +
      `**New Rank:** ${role.name}\n` +
      `**Promoted By:** ${interaction.user}`;

    await sendLog(guild, "Rank Promotion", description, COLORS.success);

    await sendDM(
      user,
      "Rank Promotion",
      `You've been promoted to **${role.name}** in **${guild.name}**.`,
      COLORS.success
    );

    return interaction.editReply({
      embeds: [
        makeEmbed("Rank Promotion", description, COLORS.success)
      ]
    });
  }

  if (name === "rank") {
    if (interaction.guildId !== SOURCE_GUILD_ID) {
      return interaction.reply({
        embeds: [makeEmbed("Wrong Server", "Use this command in the source server.", COLORS.error)],
        ephemeral: true
      });
    }

    const user = interaction.options.getUser("user", true);
    const match = findRank(interaction.options.getString("role", true));

    if (match.error) {
      return interaction.reply({
        embeds: [makeEmbed("Invalid Rank", match.error, COLORS.error)],
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const sourceGuild = interaction.guild;
    const targetGuild = await getGuild(TARGET_GUILD_ID);

    if (!targetGuild) {
      return interaction.editReply({
        embeds: [makeEmbed("Destination Unavailable", "The bot cannot access the destination server.", COLORS.error)]
      });
    }

    if (sourceGuild.id === targetGuild.id) {
      return interaction.editReply({
        embeds: [makeEmbed("Configuration Error", "Source and destination servers must be different.", COLORS.error)]
      });
    }

    const member = await sourceGuild.members.fetch(user.id).catch(() => null);

    if (!member) {
      return interaction.editReply({
        embeds: [makeEmbed("Player Not Found", "That player is not in the source server.", COLORS.warning)]
      });
    }

    if (user.id === interaction.user.id || user.id === sourceGuild.ownerId) {
      return interaction.editReply({
        embeds: [makeEmbed("Action Blocked", "You cannot rank-kick yourself or the server owner.", COLORS.error)]
      });
    }

    const rankRole = targetGuild.roles.cache.find(
      role => normalize(role.name) === normalize(match.rank)
    );

    if (!rankRole || rankRole.managed || rankRole.id === targetGuild.id) {
      return interaction.editReply({
        embeds: [makeEmbed("Rank Role Missing", `Create this role in the destination server first:\n${match.rank}`, COLORS.error)]
      });
    }

    const sourceBot = sourceGuild.members.me;
    const targetBot = await targetGuild.members.fetchMe();

    if (
      !sourceBot?.permissions.has(PermissionFlagsBits.KickMembers) ||
      !member.kickable
    ) {
      return interaction.editReply({
        embeds: [makeEmbed("Kick Failed", "Check the bot's Kick Members permission and role hierarchy in the source server. No one was kicked.", COLORS.error)]
      });
    }

    if (
      !targetBot.permissions.has(PermissionFlagsBits.ManageRoles) ||
      targetBot.roles.highest.comparePositionTo(rankRole) <= 0
    ) {
      return interaction.editReply({
        embeds: [makeEmbed("Role Assignment Error", "The bot needs Manage Roles, and its highest role must be above the requested rank in the destination server.", COLORS.error)]
      });
    }

    const resultsChannel = await getResultsChannel(sourceGuild);

    if (!resultsChannel) {
      return interaction.editReply({
        embeds: [makeEmbed("Trial Results Error", "The bot cannot access TRIAL_RESULTS_CHANNEL_ID. No one was kicked.", COLORS.error)]
      });
    }

    data.pending[user.id] = {
      rankName: rankRole.name,
      roleId: rankRole.id,
      requestedBy: interaction.user.id,
      createdAt: Date.now()
    };

    saveData();

    const dmSent = await sendDM(
      user,
      "Rank Update",
      `You've been ranked to **${rankRole.name}**.\n\nJoin the ranking server to receive your role:\n${TARGET_INVITE_URL}`,
      COLORS.success
    );

    const posted = await postRankResult({
      guild: sourceGuild,
      player: user,
      rank: rankRole,
      issuer: interaction.user
    });

    if (!posted) {
      delete data.pending[user.id];
      saveData();

      return interaction.editReply({
        embeds: [makeEmbed("Trial Results Failed", "The announcement could not be posted, so the player was not kicked.", COLORS.error)]
      });
    }

    try {
      await member.kick(`Ranked to ${rankRole.name} by ${interaction.user.tag}`);
    } catch (error) {
      await sendLog(
        sourceGuild,
        "Rank Announcement — Kick Failed",
        `Player: ${user.tag}\nRank: ${rankRole.name}\nError: ${error.message}`,
        COLORS.error
      );

      return interaction.editReply({
        embeds: [makeEmbed("Rank Posted — Kick Failed", `The result was announced, but Discord rejected the kick.\n\n**Error:** ${error.message}\n\nThe pending rank remains saved.`, COLORS.error)]
      });
    }

    return interaction.editReply({
      embeds: [
        makeEmbed(
          "Rank Completed",
          `**Player:** ${user}\n**Rank:** ${rankRole.name}\n**Ranked By:** ${interaction.user}\n**Trial Results:** Posted\n**DM:** ${dmSent ? "Sent" : "Could not send"}\n**Source Server:** Player kicked\n\nTheir rank will be assigned automatically when they join the destination server.`,
          COLORS.success
        )
      ]
    });
  }
});

client.on(Events.GuildMemberAdd, async member => {
  if (member.guild.id === TARGET_GUILD_ID) {
    const pending = data.pending[member.id];

    if (pending) {
      const role =
        member.guild.roles.cache.get(pending.roleId) ||
        member.guild.roles.cache.find(
          candidate => normalize(candidate.name) === normalize(pending.rankName)
        );

      if (!role || role.managed || role.id === member.guild.id) {
        console.error(`Pending rank role missing for ${member.user.tag}.`);
        return;
      }

      const botMember = await member.guild.members.fetchMe();

      if (
        !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
        botMember.roles.highest.comparePositionTo(role) <= 0
      ) {
        console.error(`Cannot assign pending rank to ${member.user.tag}: check role hierarchy.`);
        return;
      }

      try {
        await member.roles.add(role, "Pending trial rank");
        delete data.pending[member.id];
        saveData();

        await sendDM(
          member.user,
          "Rank Applied",
          `Your rank has been applied: **${role.name}**.`,
          COLORS.success
        );

        console.log(`Applied ${role.name} to ${member.user.tag}.`);
      } catch (error) {
        console.error("Pending rank error:", error.message);
      }
    }
  }

  if (member.user.bot) {
    handleAntiNuke(
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
    await sendLog(
      member.guild,
      "Anti-Raid: Join Burst",
      "Eight members joined within 15 seconds. Review the join list and Discord Raid Protection.",
      COLORS.warning
    );
  }
});

async function start() {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
}

start().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});
