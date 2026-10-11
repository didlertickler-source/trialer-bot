require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  AuditLogEvent
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const SOURCE_GUILD_ID = process.env.SOURCE_GUILD_ID;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;
const TRIAL_RESULTS_CHANNEL_ID = process.env.TRIAL_RESULTS_CHANNEL_ID;
const TARGET_INVITE_URL = process.env.TARGET_INVITE_URL || "";
const SECURITY_LOG_CHANNEL_ID =
  process.env.SECURITY_LOG_CHANNEL_ID ||
  process.env.RANK_LOG_CHANNEL_ID ||
  "";

const TRIALER_ROLE_NAME = "𓆩˙⸸˙𓆪︱trialer";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "state.json");

if (!TOKEN || !CLIENT_ID || !SOURCE_GUILD_ID || !TARGET_GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, SOURCE_GUILD_ID or TARGET_GUILD_ID.");
  process.exit(1);
}

const defaultState = {
  pending: {},
  trials: {},
  rankRoleIds: [],
  antiraid: false,
  antinuke: false,
  raidMessages: {},
  recentJoins: {},
  destructiveActions: {}
};

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { ...defaultState };

    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    return {
      ...defaultState,
      ...data,
      pending: data.pending || {},
      trials: data.trials || {},
      rankRoleIds: data.rankRoleIds || [],
      raidMessages: {},
      recentJoins: {},
      destructiveActions: {}
    };
  } catch (error) {
    console.error("Could not load saved state:", error.message);
    return { ...defaultState };
  }
}

let state = loadState();

function saveState() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("Could not save state:", error.message);
  }
}

const COLORS = {
  main: 0x202225,
  green: 0x36b37e,
  red: 0xed4245,
  yellow: 0xfee75c,
  blue: 0x5865f2
};

function makeEmbed(title, description, color) {
  return new EmbedBuilder()
    .setColor(color || COLORS.main)
    .setTitle(title)
    .setDescription(description || "No details provided.")
    .setFooter({ text: "Server Management" })
    .setTimestamp();
}

async function replyEmbed(interaction, title, description, color, ephemeral) {
  const embed = makeEmbed(title, description, color);

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed] });
  }

  return interaction.reply({
    embeds: [embed],
    ephemeral: ephemeral !== false
  });
}

async function logMessage(title, description, color) {
  if (!SECURITY_LOG_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(SECURITY_LOG_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    await channel.send({
      embeds: [makeEmbed(title, description, color)]
    });
  } catch (error) {
    console.error("Log message failed:", error.message);
  }
}

async function getTargetGuild() {
  return client.guilds.cache.get(TARGET_GUILD_ID) ||
    await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);
}

async function getSourceGuild() {
  return client.guilds.cache.get(SOURCE_GUILD_ID) ||
    await client.guilds.fetch(SOURCE_GUILD_ID).catch(() => null);
}

function findRole(guild, roleName) {
  if (!guild || !roleName) return null;

  const wanted = roleName.trim().toLowerCase();

  return guild.roles.cache.find(
    role => role.name.toLowerCase() === wanted
  ) || null;
}

function isAdmin(member) {
  return Boolean(
    member &&
    member.permissions &&
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

function hasTrialerRole(member) {
  return Boolean(
    member &&
    member.roles &&
    member.roles.cache.some(role => role.name === TRIALER_ROLE_NAME)
  );
}

function isStaff(member) {
  return isAdmin(member) || hasTrialerRole(member);
}

function isKnownRankRole(role) {
  if (!role || role.name === "@everyone") return false;

  const name = role.name.toLowerCase().trim();

  const rankNames = [
    "starting",
    "starter",
    "start",
    "trial",
    "trials",
    "reserve",
    "reserves",
    "academy",
    "captain",
    "player",
    "member",
    "rank"
  ];

  if (rankNames.some(term => name === term || name.includes(term))) {
    return true;
  }

  return state.rankRoleIds.includes(role.id);
}

async function getRankStatus(userId) {
  const guild = await getTargetGuild();
  if (!guild) {
    return { error: "The target server is unavailable. Please try again later." };
  }

  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) {
    return { ranked: false, member: null };
  }

  const rankRole = member.roles.cache.find(role => isKnownRankRole(role));

  return {
    ranked: Boolean(rankRole),
    rankRole: rankRole || null,
    member
  };
}

function getOpenTrial(userId) {
  return Object.values(state.trials).find(
    trial => trial.requesterId === userId && trial.status === "open"
  );
}

function safeText(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, 1000);
}

async function getTrialChannel(interaction) {
  if (TRIAL_RESULTS_CHANNEL_ID) {
    const channel = await client.channels.fetch(TRIAL_RESULTS_CHANNEL_ID)
      .catch(() => null);

    if (channel && channel.isTextBased()) return channel;
  }

  return interaction.channel;
}

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check the bot's latency."),

  new SlashCommandBuilder()
    .setName("antiraid")
    .setDescription("Enable or disable anti-raid protection.")
    .addStringOption(option =>
      option.setName("state")
        .setDescription("Protection state")
        .setRequired(true)
        .addChoices(
          { name: "On", value: "on" },
          { name: "Off", value: "off" }
        )
    ),

  new SlashCommandBuilder()
    .setName("antinuke")
    .setDescription("Enable or disable anti-nuke monitoring.")
    .addStringOption(option =>
      option.setName("state")
        .setDescription("Protection state")
        .setRequired(true)
        .addChoices(
          { name: "On", value: "on" },
          { name: "Off", value: "off" }
        )
    ),

  new SlashCommandBuilder()
    .setName("asktrial")
    .setDescription("Submit a trial request.")
    .addStringOption(option =>
      option.setName("robloxuser")
        .setDescription("Your Roblox username")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("position")
        .setDescription("The position you play")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName("activity")
        .setDescription("How active are you out of 10?")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(10)
    )
    .addStringOption(option =>
      option.setName("areyougood")
        .setDescription("How would you describe your ability?")
        .setRequired(true)
        .addChoices(
          { name: "Yes", value: "Yes" },
          { name: "Somewhat", value: "Somewhat" },
          { name: "Still improving", value: "Still improving" }
        )
    ),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Give a member a rank in the target server.")
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The member to rank")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("rank")
        .setDescription("Type the exact target-server role name")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Check a member's pending rank.")
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The member to check")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("promote")
    .setDescription("Change a member's rank in the target server.")
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The member to promote")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("rank")
        .setDescription("Type the exact target-server role name")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Show information about this server."),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Show information about a member.")
    .addUserOption(option =>
      option.setName("user")
        .setDescription("Member to inspect")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a member's avatar.")
    .addUserOption(option =>
      option.setName("user")
        .setDescription("Member whose avatar to show")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("Show information about a role.")
    .addRoleOption(option =>
      option.setName("role")
        .setDescription("Role to inspect")
        .setRequired(true)
    )
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, SOURCE_GUILD_ID),
    { body: commands }
  );

  console.log("Slash commands registered.");
}

client.once("ready", async () => {
  console.log("Logged in as " + client.user.tag);

  try {
    await registerCommands();
  } catch (error) {
    console.error("Slash command registration failed:", error.message);
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      const member = interaction.member;

      if (name === "ping") {
        const ping = Math.round(client.ws.ping);

        return replyEmbed(
          interaction,
          "Pong",
          "Bot latency: **" + ping + " ms**",
          COLORS.green
        );
      }

      if (name === "antiraid" || name === "antinuke") {
        if (!isAdmin(member)) {
          return replyEmbed(
            interaction,
            "Permission denied",
            "Only administrators can change security settings.",
            COLORS.red
          );
        }

        const enabled = interaction.options.getString("state") === "on";

        if (name === "antiraid") {
          state.antiraid = enabled;
        } else {
          state.antinuke = enabled;
        }

        saveState();

        await replyEmbed(
          interaction,
          enabled ? "Protection enabled" : "Protection disabled",
          "**" + name.toUpperCase() + "** is now **" +
            (enabled ? "ON" : "OFF") + "**.",
          enabled ? COLORS.green : COLORS.yellow
        );

        await logMessage(
          "Security settings changed",
          interaction.user.tag + " set " + name + " to " +
            (enabled ? "ON" : "OFF") + ".",
          COLORS.blue
        );

        return;
      }

      if (name === "asktrial") {
        await interaction.deferReply({ ephemeral: true });

        const status = await getRankStatus(interaction.user.id);

        if (status.error) {
          return replyEmbed(interaction, "Unable to check rank", status.error, COLORS.red);
        }

        if (status.ranked) {
          return replyEmbed(
            interaction,
            "Trial request unavailable",
            "You already have a rank in the target server (**" +
              status.rankRole.name + "**). You cannot submit another trial request.",
            COLORS.red
          );
        }

        const existing = getOpenTrial(interaction.user.id);

        if (existing) {
          return replyEmbed(
            interaction,
            "Request already open",
            "You already have a trial request waiting to be claimed.",
            COLORS.yellow
          );
        }

        const sourceGuild = await getSourceGuild();

        if (!sourceGuild) {
          return replyEmbed(
            interaction,
            "Server unavailable",
            "The trial server could not be found.",
            COLORS.red
          );
        }

        const trialerRole = findRole(sourceGuild, TRIALER_ROLE_NAME);

        if (!trialerRole) {
          return replyEmbed(
            interaction,
            "Trial role missing",
            "I couldn't find the role named **" + TRIALER_ROLE_NAME +
              "** in the source server. Check the role name.",
            COLORS.red
          );
        }

        const robloxUser = safeText(
          interaction.options.getString("robloxuser"),
          "Not provided"
        );
        const position = safeText(
          interaction.options.getString("position"),
          "Not provided"
        );
        const activity = interaction.options.getInteger("activity");
        const ability = interaction.options.getString("areyougood");

        const embed = makeEmbed(
          "New Trial Request",
          "A member has submitted a trial request.",
          COLORS.blue
        ).addFields(
          { name: "Discord User", value: interaction.user.toString(), inline: true },
          { name: "Roblox Username", value: robloxUser, inline: true },
          { name: "Position", value: position, inline: true },
          { name: "Activity", value: activity + "/10", inline: true },
          { name: "Ability", value: ability, inline: true },
          { name: "Status", value: "Waiting to be claimed", inline: false }
        );

        const channel = await getTrialChannel(interaction);

        if (!channel || !channel.isTextBased()) {
          return replyEmbed(
            interaction,
            "Channel unavailable",
            "The trial request channel could not be found.",
            COLORS.red
          );
        }

        const trialId = interaction.user.id + "-" + Date.now();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("claimtrial:" + trialId)
            .setLabel("Claim Trial")
            .setStyle(ButtonStyle.Primary)
        );

        const posted = await channel.send({
          content: trialerRole.toString(),
          embeds: [embed],
          components: [row],
          allowedMentions: { roles: [trialerRole.id] }
        });

        state.trials[trialId] = {
          requesterId: interaction.user.id,
          messageId: posted.id,
          channelId: channel.id,
          guildId: sourceGuild.id,
          status: "open",
          createdAt: Date.now()
        };

        saveState();

        return replyEmbed(
          interaction,
          "Trial request submitted",
          "Your request has been sent to the trial team.",
          COLORS.green
        );
      }

      if (name === "rank") {
        if (!isStaff(member)) {
          return replyEmbed(
            interaction,
            "Permission denied",
            "Only administrators or trialers can use this command.",
            COLORS.red
          );
        }

        await interaction.deferReply({ ephemeral: true });

        const user = interaction.options.getUser("user");
        const rankName = interaction.options.getString("rank").trim();
        const targetGuild = await getTargetGuild();

        if (!targetGuild) {
          return replyEmbed(
            interaction,
            "Target server unavailable",
            "I couldn't access the target server.",
            COLORS.red
          );
        }

        const role = findRole(targetGuild, rankName);

        if (!role) {
          return replyEmbed(
            interaction,
            "Rank not found",
            "There is no role named **" + rankName +
              "** in the target server. Type the role name exactly.",
            COLORS.red
          );
        }

        if (role.id === targetGuild.id || role.managed) {
          return replyEmbed(
            interaction,
            "Invalid rank",
            "That role cannot be assigned as a rank.",
            COLORS.red
          );
        }

        if (
          targetGuild.members.me &&
          role.position >= targetGuild.members.me.roles.highest.position
        ) {
          return replyEmbed(
            interaction,
            "Role hierarchy error",
            "Move the bot's role above **" + role.name +
              "** in the target server.",
            COLORS.red
          );
        }

        state.pending[user.id] = {
          roleId: role.id,
          roleName: role.name,
          targetGuildId: targetGuild.id,
          approvedBy: interaction.user.id,
          approvedAt: Date.now()
        };

        if (!state.rankRoleIds.includes(role.id)) {
          state.rankRoleIds.push(role.id);
        }

        saveState();

        let dmStatus = "The rank is ready to be assigned when the member joins the target server.";

        try {
          await user.send({
            embeds: [
              makeEmbed(
                "Trial Result",
                "Your trial has been processed.\n\nRank: **" + role.name + "**" +
                  (TARGET_INVITE_URL ? "\n\nJoin the server: " + TARGET_INVITE_URL : ""),
                COLORS.green
              )
            ]
          });

          dmStatus = "The member has been sent a DM.";
        } catch {
          dmStatus = "The member's DMs are closed. Their rank is still pending.";
        }

        await logMessage(
          "Rank approved",
          "Member: " + user.tag + "\nRank: " + role.name +
            "\nApproved by: " + interaction.user.tag,
          COLORS.green
        );

        const sourceGuild = await getSourceGuild();

        if (sourceGuild) {
          const sourceMember = await sourceGuild.members.fetch(user.id).catch(() => null);

          if (
            sourceMember &&
            sourceGuild.members.me &&
            sourceGuild.members.me.permissions.has(PermissionFlagsBits.KickMembers) &&
            sourceMember.kickable
          ) {
            await sourceMember.kick("Trial processed; rank: " + role.name)
              .catch(() => null);
          }
        }

        return replyEmbed(
          interaction,
          "Rank approved",
          "Member: " + user.toString() +
            "\nRank: **" + role.name + "**\n" + dmStatus,
          COLORS.green
        );
      }

      if (name === "check") {
        if (!isStaff(member)) {
          return replyEmbed(
            interaction,
            "Permission denied",
            "Only administrators or trialers can use this command.",
            COLORS.red
          );
        }

        const user = interaction.options.getUser("user");
        const pending = state.pending[user.id];

        if (!pending) {
          return replyEmbed(
            interaction,
            "No pending rank",
            user.toString() + " has no pending rank assignment.",
            COLORS.yellow
          );
        }

        return replyEmbed(
          interaction,
          "Pending rank",
          "Member: " + user.toString() +
            "\nRank: **" + pending.roleName + "**",
          COLORS.blue
        );
      }

      if (name === "promote") {
        if (!isStaff(member)) {
          return replyEmbed(
            interaction,
            "Permission denied",
            "Only administrators or trialers can use this command.",
            COLORS.red
          );
        }

        await interaction.deferReply({ ephemeral: true });

        const user = interaction.options.getUser("user");
        const rankName = interaction.options.getString("rank").trim();
        const targetGuild = await getTargetGuild();

        if (!targetGuild) {
          return replyEmbed(
            interaction,
            "Target server unavailable",
            "I couldn't access the target server.",
            COLORS.red
          );
        }

        const targetMember = await targetGuild.members.fetch(user.id).catch(() => null);

        if (!targetMember) {
          return replyEmbed(
            interaction,
            "Member not found",
            "That user must join the target server before being promoted.",
            COLORS.red
          );
        }

        const role = findRole(targetGuild, rankName);

        if (!role || role.id === targetGuild.id || role.managed) {
          return replyEmbed(
            interaction,
            "Rank not found",
            "I couldn't find an assignable role named **" + rankName + "**.",
            COLORS.red
          );
        }

        if (
          !targetGuild.members.me ||
          role.position >= targetGuild.members.me.roles.highest.position
        ) {
          return replyEmbed(
            interaction,
            "Role hierarchy error",
            "Move the bot's role above **" + role.name + "**.",
            COLORS.red
          );
        }

        const oldRankRoles = targetMember.roles.cache.filter(
          oldRole => isKnownRankRole(oldRole) &&
            oldRole.id !== targetGuild.id &&
            oldRole.id !== role.id &&
            !oldRole.managed
        );

        try {
          if (oldRankRoles.size) {
            await targetMember.roles.remove(oldRankRoles);
          }

          await targetMember.roles.add(role);

          if (!state.rankRoleIds.includes(role.id)) {
            state.rankRoleIds.push(role.id);
          }

          delete state.pending[user.id];
          saveState();
        } catch (error) {
          return replyEmbed(
            interaction,
            "Promotion failed",
            "I couldn't update the member's roles. Check my Manage Roles permission and role hierarchy.\n\n" +
              error.message,
            COLORS.red
          );
        }

        await logMessage(
          "Member promoted",
          "Member: " + user.tag + "\nNew rank: " + role.name +
            "\nChanged by: " + interaction.user.tag,
          COLORS.green
        );

        return replyEmbed(
          interaction,
          "Promotion complete",
          user.toString() + " now has the rank **" + role.name + "**.",
          COLORS.green
        );
      }

      if (name === "serverinfo") {
        const guild = interaction.guild;

        return replyEmbed(
          interaction,
          "Server Information",
          "**Name:** " + guild.name +
            "\n**Members:** " + guild.memberCount +
            "\n**Created:** <t:" + Math.floor(guild.createdTimestamp / 1000) + ":D>" +
            "\n**Owner:** <@" + guild.ownerId + ">",
          COLORS.blue
        );
      }

      if (name === "userinfo") {
        const user = interaction.options.getUser("user") || interaction.user;
        const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);

        const roles = targetMember
          ? targetMember.roles.cache
              .filter(role => role.id !== interaction.guild.id)
              .map(role => role.toString())
              .slice(0, 15)
              .join(", ") || "No roles"
          : "Not in this server";

        return interaction.reply({
          embeds: [
            makeEmbed(
              "User Information",
              "**User:** " + user.tag +
                "\n**ID:** " + user.id +
                "\n**Created:** <t:" + Math.floor(user.createdTimestamp / 1000) + ":F>" +
                "\n**Joined:** " + (
                  targetMember
                    ? "<t:" + Math.floor(targetMember.joinedTimestamp / 1000) + ":F>"
                    : "Not in this server"
                ) +
                "\n**Roles:** " + roles,
              COLORS.blue
            ).setThumbnail(user.displayAvatarURL({ size: 256 }))
          ],
          ephemeral: true
        });
      }

      if (name === "avatar") {
        const user = interaction.options.getUser("user") || interaction.user;

        return interaction.reply({
          embeds: [
            makeEmbed(
              user.tag + "'s Avatar",
              "[Open full-size avatar](" +
                user.displayAvatarURL({ size: 1024, extension: "png" }) + ")",
              COLORS.blue
            ).setImage(user.displayAvatarURL({ size: 1024 }))
          ],
          ephemeral: true
        });
      }

      if (name === "roleinfo") {
        const role = interaction.options.getRole("role");

        return replyEmbed(
          interaction,
          "Role Information",
          "**Name:** " + role.name +
            "\n**ID:** " + role.id +
            "\n**Members:** " + role.members.size +
            "\n**Position:** " + role.position +
            "\n**Mentionable:** " + (role.mentionable ? "Yes" : "No") +
            "\n**Color:** " + role.hexColor,
          COLORS.blue
        );
      }
    }

    if (interaction.isButton()) {
      if (!interaction.customId.startsWith("claimtrial:")) return;

      const trialId = interaction.customId.slice("claimtrial:".length);
      const trial = state.trials[trialId];

      if (!trial || trial.status !== "open") {
        return interaction.reply({
          embeds: [
            makeEmbed(
              "Request unavailable",
              "This trial request has already been claimed or is no longer available.",
              COLORS.red
            )
          ],
          ephemeral: true
        });
      }

      const clicker = interaction.member;

      if (!isAdmin(clicker) && !hasTrialerRole(clicker)) {
        return interaction.reply({
          embeds: [
            makeEmbed(
              "Permission denied",
              "Only administrators or members with the **" +
                TRIALER_ROLE_NAME + "** role can claim trial requests.",
              COLORS.red
            )
          ],
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      trial.status = "claimed";
      trial.claimedBy = interaction.user.id;
      trial.claimedAt = Date.now();
      saveState();

      try {
        const requester = await client.users.fetch(trial.requesterId);

        await requester.send({
          embeds: [
            makeEmbed(
              "Your Trial Request Has Been Claimed",
              "Your request has been claimed by " + interaction.user.tag +
                ". Please wait for the trial team to contact you with the next steps.",
              COLORS.green
            )
          ]
        });
      } catch {
        await logMessage(
          "Trial DM failed",
          "Couldn't DM the requester with ID " + trial.requesterId + ".",
          COLORS.yellow
        );
      }

      const claimedEmbed = makeEmbed(
        "Trial Request",
        "This request has been claimed.",
        COLORS.green
      ).addFields(
        { name: "Claimed By", value: interaction.user.toString(), inline: true },
        { name: "Requester", value: "<@" + trial.requesterId + ">", inline: true },
        { name: "Status", value: "Claimed", inline: true }
      );

      await interaction.message.edit({
        embeds: [claimedEmbed],
        components: []
      }).catch(() => null);

      await replyEmbed(
        interaction,
        "Trial claimed",
        "You claimed this trial request. The requester has been notified by DM.",
        COLORS.green
      );

      await logMessage(
        "Trial claimed",
        "Requester: <@" + trial.requesterId + ">\nClaimed by: " +
          interaction.user.tag,
        COLORS.green
      );
    }
  } catch (error) {
    console.error("Interaction error:", error);

    const embed = makeEmbed(
      "Something went wrong",
      "The command failed. Check the Railway logs for the error.",
      COLORS.red
    );

    if (interaction.deferred) {
      await interaction.editReply({ embeds: [embed] }).catch(() => null);
    } else if (!interaction.replied) {
      await interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => null);
    }
  }
});

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;

  if (message.content.startsWith("?")) {
    const args = message.content.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const member = message.member;

    if (command === "?ping") {
      if (!isAdmin(member)) {
        return message.reply({
          embeds: [
            makeEmbed("Permission denied", "Administrator permission required.", COLORS.red)
          ]
        });
      }

      return message.reply({
        embeds: [
          makeEmbed(
            "Pong",
            "Bot latency: **" + Math.round(client.ws.ping) + " ms**",
            COLORS.green
          )
        ]
      });
    }

    if (command === "?membercount") {
      if (!isAdmin(member)) {
        return message.reply({
          embeds: [
            makeEmbed("Permission denied", "Administrator permission required.", COLORS.red)
          ]
        });
      }

      return message.reply({
        embeds: [
          makeEmbed(
            "Member Count",
            "This server has **" + message.guild.memberCount + "** members.",
            COLORS.blue
          )
        ]
      });
    }

    if (command === "?whosflorian") {
      if (!isAdmin(member)) {
        return message.reply({
          embeds: [
            makeEmbed("Permission denied", "Administrator permission required.", COLORS.red)
          ]
        });
      }

      return message.reply({
        embeds: [makeEmbed("Answer", "de goat", COLORS.green)]
      });
    }
  }

  if (!state.antiraid) return;

  const now = Date.now();
  const userId = message.author.id;

  if (!state.raidMessages[userId]) {
    state.raidMessages[userId] = [];
  }

  state.raidMessages[userId] = state.raidMessages[userId].filter(
    timestamp => now - timestamp < 6000
  );

  state.raidMessages[userId].push(now);

  if (
    state.raidMessages[userId].length >= 6 &&
    !isAdmin(message.member) &&
    message.member.moderatable
  ) {
    state.raidMessages[userId] = [];

    await message.member.timeout(60000, "Anti-raid: message spam")
      .catch(() => null);

    await logMessage(
      "Anti-raid action",
      message.author.tag + " was timed out for message spam.",
      COLORS.red
    );
  }
});

client.on("guildMemberAdd", async member => {
  if (state.antiraid) {
    const now = Date.now();
    const guildId = member.guild.id;

    if (!state.recentJoins[guildId]) {
      state.recentJoins[guildId] = [];
    }

    state.recentJoins[guildId] = state.recentJoins[guildId].filter(
      timestamp => now - timestamp < 15000
    );

    state.recentJoins[guildId].push(now);

    if (state.recentJoins[guildId].length >= 8) {
      await logMessage(
        "Possible join raid",
        "Eight or more members joined within 15 seconds in **" +
          member.guild.name + "**.",
        COLORS.red
      );

      state.recentJoins[guildId] = [];
    }
  }

  if (member.guild.id !== TARGET_GUILD_ID) return;

  const pending = state.pending[member.id];
  if (!pending) return;

  const role = member.guild.roles.cache.get(pending.roleId);

  if (!role) {
    await logMessage(
      "Pending rank failed",
      "The saved role **" + pending.roleName + "** no longer exists.",
      COLORS.red
    );
    return;
  }

  try {
    await member.roles.add(role, "Approved rank assignment");

    delete state.pending[member.id];
    saveState();

    await logMessage(
      "Rank assigned",
      member.user.tag + " joined the target server and received **" +
        role.name + "**.",
      COLORS.green
    );

    try {
      await member.send({
        embeds: [
          makeEmbed(
            "Rank Assigned",
            "Welcome! Your rank **" + role.name + "** has been assigned.",
            COLORS.green
          )
        ]
      });
    } catch {}
  } catch (error) {
    await logMessage(
      "Rank assignment failed",
      "Couldn't assign **" + role.name + "** to " + member.user.tag +
        ". Error: " + error.message,
      COLORS.red
    );
  }
});

async function findAuditExecutor(guild, type) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 1 });
    const entry = logs.entries.first();

    if (!entry) return null;
    if (Date.now() - entry.createdTimestamp > 15000) return null;

    return entry.executor || null;
  } catch {
    return null;
  }
}

async function handleDestructiveEvent(guild, eventName, auditType) {
  if (!state.antinuke) return;

  const executor = await findAuditExecutor(guild, auditType);

  await logMessage(
    "Anti-nuke alert",
    "**Event:** " + eventName +
      "\n**Server:** " + guild.name +
      "\n**Executor:** " + (executor ? executor.tag : "Unknown") +
      "\n\nThis action may be destructive. Check the audit log.",
    COLORS.red
  );

  if (!executor) return;

  const now = Date.now();

  if (!state.destructiveActions[executor.id]) {
    state.destructiveActions[executor.id] = [];
  }

  state.destructiveActions[executor.id] =
    state.destructiveActions[executor.id].filter(
      timestamp => now - timestamp < 30000
    );

  state.destructiveActions[executor.id].push(now);

  if (state.destructiveActions[executor.id].length < 2) return;

  state.destructiveActions[executor.id] = [];

  const actor = await guild.members.fetch(executor.id).catch(() => null);

  if (!actor || isAdmin(actor)) {
    await logMessage(
      "Anti-nuke escalation skipped",
      "The actor couldn't be safely actioned automatically. Review the audit log.",
      COLORS.yellow
    );
    return;
  }

  const dangerousRoles = actor.roles.cache.filter(role =>
    role.permissions.has(PermissionFlagsBits.Administrator) ||
    role.permissions.has(PermissionFlagsBits.ManageGuild) ||
    role.permissions.has(PermissionFlagsBits.ManageRoles) ||
    role.permissions.has(PermissionFlagsBits.ManageChannels) ||
    role.permissions.has(PermissionFlagsBits.ManageWebhooks)
  );

  if (!dangerousRoles.size) return;

  try {
    await actor.roles.remove(dangerousRoles, "Anti-nuke: repeated destructive actions");

    await logMessage(
      "Anti-nuke response",
      "Removed dangerous-permission roles from " + executor.tag +
        " after repeated destructive actions.",
      COLORS.red
    );
  } catch (error) {
    await logMessage(
      "Anti-nuke response failed",
      "Couldn't remove dangerous roles from " + executor.tag +
        ". Check bot permissions and role hierarchy.\n" + error.message,
      COLORS.red
    );
  }
}

client.on("channelDelete", channel => {
  if (channel.guild) {
    handleDestructiveEvent(
      channel.guild,
      "Channel deleted",
      AuditLogEvent.ChannelDelete
    );
  }
});

client.on("roleDelete", role => {
  handleDestructiveEvent(
    role.guild,
    "Role deleted",
    AuditLogEvent.RoleDelete
  );
});

client.on("webhookUpdate", channel => {
  if (channel.guild) {
    handleDestructiveEvent(
      channel.guild,
      "Webhooks updated",
      AuditLogEvent.WebhookUpdate
    );
  }
});

client.on("guildMemberAdd", async member => {
  if (!state.antinuke || !member.user.bot) return;

  await logMessage(
    "Bot added to server",
    "A bot joined **" + member.guild.name +
      "**: " + member.user.tag +
      ". Review the audit log to confirm who added it.",
    COLORS.yellow
  );
});

client.login(TOKEN);
