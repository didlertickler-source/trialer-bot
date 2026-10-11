require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AuditLogEvent,
  EmbedBuilder,
  ChannelType
} = require("discord.js");

const fs = require("fs");
const path = require("path");

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

if (!TOKEN || !CLIENT_ID || !SOURCE_GUILD_ID || !TARGET_GUILD_ID) {
  console.error("Missing required Railway environment variables.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.User, Partials.GuildMember]
});

const COLORS = {
  main: 0x17191f,
  success: 0x35c98b,
  error: 0xe05260,
  warning: 0xe6ad4b,
  info: 0x8294ff
};

const FOOTER = "ELITE SECURITY  •  SYSTEM";

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "state.json");

const defaultState = {
  antiraid: false,
  antinuke: false,
  pending: {},
  nukeEvents: {},
  spam: {}
};

let state = { ...defaultState };

function loadState() {
  try {
    const dir = path.dirname(DATA_FILE);
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      state = { ...defaultState, ...saved };
    } else {
      saveState();
    }
  } catch (error) {
    console.error("State loading failed:", error.message);
    state = { ...defaultState };
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("State saving failed:", error.message);
  }
}

loadState();

function makeEmbed(title, description, color = COLORS.main) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description || "No additional information.")
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function successEmbed(title, description) {
  return makeEmbed(title, description, COLORS.success);
}

function errorEmbed(title, description) {
  return makeEmbed(title, description, COLORS.error);
}

function warningEmbed(title, description) {
  return makeEmbed(title, description, COLORS.warning);
}

function infoEmbed(title, description) {
  return makeEmbed(title, description, COLORS.info);
}

function statusText(enabled) {
  return enabled ? "ENABLED" : "DISABLED";
}

function statusEmbed(name, enabled, details) {
  return makeEmbed(
    `${enabled ? "🛡️" : "⚙️"}  ${name.toUpperCase()}`,
    [
      `**Status:** ${enabled ? "🟢 ENABLED" : "🔴 DISABLED"}`,
      "",
      details
    ].join("\n"),
    enabled ? COLORS.success : COLORS.warning
  );
}

async function sendLog(guild, embed) {
  try {
    let channel = null;

    if (SECURITY_LOG_CHANNEL_ID) {
      channel = await guild.channels
        .fetch(SECURITY_LOG_CHANNEL_ID)
        .catch(() => null);
    }

    if (!channel) {
      channel = guild.channels.cache.find(
        c =>
          c.type === ChannelType.GuildText &&
          /security|mod-log|logs|audit/i.test(c.name) &&
          c.permissionsFor(guild.members.me)?.has(
            PermissionFlagsBits.SendMessages
          )
      );
    }

    if (channel?.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error("Log sending failed:", error.message);
  }
}

function isAdmin(member) {
  return Boolean(
    member?.permissions?.has(PermissionFlagsBits.Administrator)
  );
}

async function requireAdmin(interaction) {
  if (isAdmin(interaction.member)) return true;

  const embed = errorEmbed(
    "ACCESS DENIED",
    "You need the **Administrator** permission to use this command."
  );

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed] }).catch(() => {});
  } else {
    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    }).catch(() => {});
  }

  return false;
}

async function editInteraction(interaction, embed, ephemeral = false) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed] }).catch(() => {});
  }

  return interaction.reply({
    embeds: [embed],
    ephemeral
  }).catch(() => {});
}

async function deferInteraction(interaction, ephemeral = true) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral }).catch(() => {});
  }
}

async function getGuild(guildId) {
  return client.guilds.fetch(guildId).catch(() => null);
}

async function getMember(guild, userId) {
  if (!guild) return null;
  return guild.members.fetch(userId).catch(() => null);
}

async function getAuditExecutor(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 6 });
    const now = Date.now();

    return logs.entries.find(entry => {
      if (!entry.executor || entry.executor.bot) return false;
      if (now - entry.createdTimestamp > 15000) return false;
      if (targetId && entry.target?.id !== targetId) return false;
      return true;
    })?.executor || null;
  } catch {
    return null;
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot response and API latency"),

  new SlashCommandBuilder()
    .setName("antiraid")
    .setDescription("Enable or disable anti-raid protection")
    .addStringOption(option =>
      option
        .setName("state")
        .setDescription("Protection state")
        .setRequired(true)
        .addChoices(
          { name: "Enable", value: "on" },
          { name: "Disable", value: "off" }
        )
    ),

  new SlashCommandBuilder()
    .setName("antinuke")
    .setDescription("Enable or disable anti-nuke protection")
    .addStringOption(option =>
      option
        .setName("state")
        .setDescription("Protection state")
        .setRequired(true)
        .addChoices(
          { name: "Enable", value: "on" },
          { name: "Disable", value: "off" }
        )
    ),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Publish a trial result and send a destination invite")
    .addUserOption(option =>
      option.setName("user").setDescription("Trial participant").setRequired(true)
    )
    .addRoleOption(option =>
      option.setName("role").setDescription("Rank to assign in the destination server").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Check a member's rank in the destination server")
    .addUserOption(option =>
      option.setName("user").setDescription("Member to check").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("promote")
    .setDescription("Change a member's rank in the destination server")
    .addUserOption(option =>
      option.setName("user").setDescription("Member to promote").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("rank").setDescription("Exact destination role name").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Display server information"),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Display member information")
    .addUserOption(option =>
      option.setName("user").setDescription("Member to inspect").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Display a member's avatar")
    .addUserOption(option =>
      option.setName("user").setDescription("Member to inspect").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("Display information about a role")
    .addRoleOption(option =>
      option.setName("role").setDescription("Role to inspect").setRequired(true)
    )
].map(command => command.toJSON());

async function registerCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, SOURCE_GUILD_ID),
      { body: commands }
    );

    console.log("Slash commands registered successfully.");
  } catch (error) {
    console.error("Command registration failed:", error);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.commandName;

  try {
    if (command === "ping") {
      await deferInteraction(interaction, false);

      const latency = Math.round(client.ws.ping);

      const embed = makeEmbed(
        "CONNECTION STATUS",
        [
          "The bot is online and responding.",
          "",
          `**WebSocket latency:** \`${latency} ms\``,
          `**Uptime:** <t:${Math.floor((Date.now() - client.uptime) / 1000)}:R>`,
          "**Status:** 🟢 Operational"
        ].join("\n"),
        COLORS.success
      );

      return editInteraction(interaction, embed);
    }

    if (command === "antiraid") {
      await deferInteraction(interaction, true);
      if (!(await requireAdmin(interaction))) return;

      const enabled = interaction.options.getString("state") === "on";
      state.antiraid = enabled;
      saveState();

      const embed = statusEmbed(
        "Anti-Raid Protection",
        enabled,
        enabled
          ? "Spam detection and join-burst monitoring are now active."
          : "Spam detection and join-burst monitoring have been disabled."
      );

      await sendLog(
        interaction.guild,
        makeEmbed(
          "ANTI-RAID CONFIGURATION",
          `**Moderator:** ${interaction.user}\n**Status:** ${statusText(enabled)}`,
          enabled ? COLORS.success : COLORS.warning
        )
      );

      return editInteraction(interaction, embed);
    }

    if (command === "antinuke") {
      await deferInteraction(interaction, true);
      if (!(await requireAdmin(interaction))) return;

      const enabled = interaction.options.getString("state") === "on";
      state.antinuke = enabled;
      saveState();

      const embed = statusEmbed(
        "Anti-Nuke Protection",
        enabled,
        enabled
          ? "Monitoring supported destructive actions and attempting to limit damage from detected attacks."
          : "Anti-nuke monitoring has been disabled."
      );

      await sendLog(
        interaction.guild,
        makeEmbed(
          "ANTI-NUKE CONFIGURATION",
          `**Moderator:** ${interaction.user}\n**Status:** ${statusText(enabled)}`,
          enabled ? COLORS.success : COLORS.warning
        )
      );

      return editInteraction(interaction, embed);
    }

    if (command === "rank") {
      await deferInteraction(interaction, true);
      if (!(await requireAdmin(interaction))) return;

      const user = interaction.options.getUser("user");
      const role = interaction.options.getRole("role");

      const sourceGuild = await getGuild(SOURCE_GUILD_ID);
      const targetGuild = await getGuild(TARGET_GUILD_ID);

      if (!sourceGuild || !targetGuild) {
        return editInteraction(
          interaction,
          errorEmbed("SERVER UNAVAILABLE", "The bot must be in both configured servers.")
        );
      }

      const sourceMember = await getMember(sourceGuild, user.id);

      if (!sourceMember) {
        return editInteraction(
          interaction,
          errorEmbed("MEMBER NOT FOUND", "That user is not a member of the source server.")
        );
      }

      const targetRole = targetGuild.roles.cache.find(
        r => r.name.toLowerCase() === role.name.toLowerCase()
      );

      if (!targetRole) {
        return editInteraction(
          interaction,
          errorEmbed(
            "RANK NOT FOUND",
            `The destination server does not have a role named **${role.name}**. Create the role there first.`
          )
        );
      }

      state.pending[user.id] = {
        roleName: targetRole.name,
        roleId: targetRole.id,
        issuedAt: Date.now()
      };
      saveState();

      let dmSent = false;

      try {
        const dmEmbed = makeEmbed(
          "TRIAL RESULTS",
          [
            `Your trial result has been processed.`,
            "",
            `**Assigned rank:** ${targetRole.name}`,
            "",
            TARGET_INVITE_URL
              ? `**Join the destination server:** ${TARGET_INVITE_URL}`
              : "Please contact a staff member for the destination server invite."
          ].join("\n"),
          COLORS.success
        );

        await user.send({ embeds: [dmEmbed] });
        dmSent = true;
      } catch {}

      if (TRIAL_RESULTS_CHANNEL_ID) {
        const resultsChannel = await sourceGuild.channels
          .fetch(TRIAL_RESULTS_CHANNEL_ID)
          .catch(() => null);

        if (resultsChannel?.isTextBased()) {
          await resultsChannel.send({
            embeds: [
              makeEmbed(
                "TRIAL RESULT",
                [
                  `**Participant:** ${user}`,
                  `**Rank:** ${targetRole.name}`,
                  `**Processed by:** ${interaction.user}`,
                  `**DM delivered:** ${dmSent ? "Yes" : "No"}`
                ].join("\n"),
                COLORS.success
              )
            ]
          }).catch(() => {});
        }
      }

      let kicked = false;
      let kickError = "";

      try {
        if (sourceMember.kickable) {
          await sourceMember.kick(`Trial result processed by ${interaction.user.tag}`);
          kicked = true;
        } else {
          kickError = "The bot cannot kick this member. Check its role hierarchy and Kick Members permission.";
        }
      } catch (error) {
        kickError = error.message;
      }

      const result = makeEmbed(
        "RANK PROCESSING COMPLETE",
        [
          `**Participant:** ${user}`,
          `**Destination rank:** ${targetRole.name}`,
          `**Trial DM:** ${dmSent ? "Delivered" : "Could not be delivered"}`,
          `**Source server removal:** ${kicked ? "Completed" : "Not completed"}`,
          `**Destination rank assignment:** Pending until the member joins`,
          "",
          kickError ? `**Note:** ${kickError}` : ""
        ].filter(Boolean).join("\n"),
        kicked ? COLORS.success : COLORS.warning
      );

      await sendLog(
        sourceGuild,
        makeEmbed(
          "RANK ACTION LOG",
          [
            `**Staff:** ${interaction.user}`,
            `**Member:** ${user.tag} (${user.id})`,
            `**Rank:** ${targetRole.name}`,
            `**Kicked:** ${kicked ? "Yes" : "No"}`
          ].join("\n"),
          COLORS.info
        )
      );

      return editInteraction(interaction, result);
    }

    if (command === "check") {
      await deferInteraction(interaction, true);
      if (!(await requireAdmin(interaction))) return;

      const user = interaction.options.getUser("user");
      const targetGuild = await getGuild(TARGET_GUILD_ID);

      if (!targetGuild) {
        return editInteraction(
          interaction,
          errorEmbed("SERVER UNAVAILABLE", "The destination server could not be found.")
        );
      }

      const member = await getMember(targetGuild, user.id);

      if (!member) {
        return editInteraction(
          interaction,
          warningEmbed("MEMBER NOT FOUND", `${user} is not in the destination server.`)
        );
      }

      const roles = member.roles.cache
        .filter(role => role.id !== targetGuild.id)
        .sort((a, b) => b.position - a.position)
        .map(role => role.name);

      const embed = makeEmbed(
        "MEMBER RANK CHECK",
        [
          `**Member:** ${user}`,
          `**Account ID:** \`${user.id}\``,
          "",
          "**Roles**",
          roles.length ? roles.map(role => `• ${role}`).join("\n") : "No assigned roles."
        ].join("\n"),
        COLORS.info
      );

      return editInteraction(interaction, embed);
    }

    if (command === "promote") {
      await deferInteraction(interaction, true);
      if (!(await requireAdmin(interaction))) return;

      const user = interaction.options.getUser("user");
      const rankName = interaction.options.getString("rank").trim();
      const targetGuild = await getGuild(TARGET_GUILD_ID);

      if (!targetGuild) {
        return editInteraction(
          interaction,
          errorEmbed("SERVER UNAVAILABLE", "The destination server could not be found.")
        );
      }

      const member = await getMember(targetGuild, user.id);

      if (!member) {
        return editInteraction(
          interaction,
          warningEmbed("MEMBER NOT FOUND", `${user} is not in the destination server.`)
        );
      }

      const role = targetGuild.roles.cache.find(
        r => r.name.toLowerCase() === rankName.toLowerCase()
      );

      if (!role) {
        return editInteraction(
          interaction,
          errorEmbed("RANK NOT FOUND", `No destination role matches **${rankName}**.`)
        );
      }

      if (
        role.managed ||
        role.position >= targetGuild.members.me.roles.highest.position
      ) {
        return editInteraction(
          interaction,
          errorEmbed(
            "ROLE HIERARCHY ERROR",
            "Move the bot's highest role above the rank role and try again."
          )
        );
      }

      const rankNames = [
        "trial",
        "reserve",
        "reserves",
        "academy",
        "starter",
        "captain",
        "owner",
        "manager",
        "player",
        "member"
      ];

      const existingRankRoles = member.roles.cache.filter(
        r =>
          r.id !== targetGuild.id &&
          rankNames.some(name => r.name.toLowerCase().includes(name))
      );

      try {
        if (existingRankRoles.size) {
          await member.roles.remove(existingRankRoles);
        }

        await member.roles.add(role);
      } catch (error) {
        return editInteraction(
          interaction,
          errorEmbed("RANK UPDATE FAILED", `Discord rejected the role change: ${error.message}`)
        );
      }

      const embed = makeEmbed(
        "RANK UPDATED",
        [
          `**Member:** ${user}`,
          `**New rank:** ${role}`,
          `**Updated by:** ${interaction.user}`,
          "",
          "The destination server role has been updated."
        ].join("\n"),
        COLORS.success
      );

      await sendLog(
        targetGuild,
        makeEmbed(
          "PROMOTION LOG",
          `**Member:** ${user}\n**New rank:** ${role.name}\n**Staff:** ${interaction.user}`,
          COLORS.info
        )
      );

      try {
        await user.send({
          embeds: [
            makeEmbed(
              "RANK UPDATE",
              `Your rank in **${targetGuild.name}** has been updated to **${role.name}**.`,
              COLORS.success
            )
          ]
        });
      } catch {}

      return editInteraction(interaction, embed);
    }

    if (command === "serverinfo") {
      await deferInteraction(interaction, false);

      const guild = interaction.guild;
      if (!guild) {
        return editInteraction(
          interaction,
          errorEmbed("SERVER UNAVAILABLE", "This command must be used in a server.")
        );
      }

      await guild.fetch().catch(() => {});

      const embed = makeEmbed(
        "SERVER OVERVIEW",
        [
          `**Name:** ${guild.name}`,
          `**Server ID:** \`${guild.id}\``,
          `**Owner:** <@${guild.ownerId}>`,
          `**Members:** ${guild.memberCount}`,
          `**Text channels:** ${guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size}`,
          `**Voice channels:** ${guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size}`,
          `**Roles:** ${guild.roles.cache.size}`,
          `**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`
        ].join("\n"),
        COLORS.info
      );

      const icon = guild.iconURL({ size: 256 });
      if (icon) embed.setThumbnail(icon);

      return editInteraction(interaction, embed);
    }

    if (command === "userinfo") {
      await deferInteraction(interaction, false);

      const user = interaction.options.getUser("user") || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      const roles = member
        ? member.roles.cache
            .filter(role => role.id !== interaction.guild.id)
            .sort((a, b) => b.position - a.position)
            .map(role => role.toString())
            .slice(0, 15)
        : [];

      const embed = makeEmbed(
        "USER PROFILE",
        [
          `**User:** ${user}`,
          `**Username:** ${user.tag}`,
          `**User ID:** \`${user.id}\``,
          `**Account created:** <t:${Math.floor(user.createdTimestamp / 1000)}:F>`,
          member
            ? `**Joined server:** <t:${Math.floor(member.joinedTimestamp / 1000)}:F>`
            : "**Server membership:** Not a member",
          "",
          "**Roles**",
          roles.length ? roles.join(" ") : "No roles to display."
        ].join("\n"),
        COLORS.info
      ).setThumbnail(user.displayAvatarURL({ size: 256 }));

      return editInteraction(interaction, embed);
    }

    if (command === "avatar") {
      await deferInteraction(interaction, false);

      const user = interaction.options.getUser("user") || interaction.user;
      const avatar = user.displayAvatarURL({ size: 1024 });

      const embed = makeEmbed(
        "AVATAR VIEWER",
        `**User:** ${user}\n[Open full-size avatar](${avatar})`,
        COLORS.info
      ).setImage(avatar);

      return editInteraction(interaction, embed);
    }

    if (command === "roleinfo") {
      await deferInteraction(interaction, false);

      const role = interaction.options.getRole("role");

      const embed = makeEmbed(
        "ROLE INFORMATION",
        [
          `**Role:** ${role}`,
          `**Role ID:** \`${role.id}\``,
          `**Color:** \`${role.hexColor}\``,
          `**Members:** ${role.members.size}`,
          `**Position:** ${role.position}`,
          `**Mentionable:** ${role.mentionable ? "Yes" : "No"}`,
          `**Hoisted:** ${role.hoist ? "Yes" : "No"}`,
          `**Created:** <t:${Math.floor(role.createdTimestamp / 1000)}:F>`
        ].join("\n"),
        COLORS.info
      );

      return editInteraction(interaction, embed);
    }
  } catch (error) {
    console.error(`Command /${command} failed:`, error);

    const embed = errorEmbed(
      "COMMAND FAILED",
      "Something went wrong while processing this command. Check the Railway deployment logs for the technical error."
    );

    await editInteraction(interaction, embed, true);
  }
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  if (state.antiraid) {
    const now = Date.now();
    const key = `${message.guild.id}:${message.author.id}`;
    const previous = state.spam[key] || [];
    const recent = previous.filter(timestamp => now - timestamp < 6000);

    recent.push(now);
    state.spam[key] = recent;

    if (recent.length >= 6) {
      const member = message.member;

      if (
        member &&
        !isAdmin(member) &&
        member.moderatable
      ) {
        try {
          await member.timeout(60000, "Anti-raid: message spam detected");

          await sendLog(
            message.guild,
            warningEmbed(
              "ANTI-RAID ALERT",
              `**Member:** ${message.author}\n**Action:** 60-second timeout\n**Reason:** Message spam detected.`
            )
          );
        } catch (error) {
          console.error("Anti-raid timeout failed:", error.message);
        }
      }

      state.spam[key] = [];
    }
  }

  if (!message.content.startsWith("?")) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const command = (args.shift() || "").toLowerCase();

  if (!["ping", "membercount", "whosflorian"].includes(command)) return;

  if (!isAdmin(message.member)) {
    return message.reply({
      embeds: [
        errorEmbed(
          "ACCESS DENIED",
          "You need the **Administrator** permission to use this prefix command."
        )
      ]
    }).catch(() => {});
  }

  try {
    if (command === "ping") {
      return message.reply({
        embeds: [
          makeEmbed(
            "CONNECTION STATUS",
            [
              "The bot is online and responding.",
              "",
              `**WebSocket latency:** \`${Math.round(client.ws.ping)} ms\``,
              "**Status:** 🟢 Operational"
            ].join("\n"),
            COLORS.success
          )
        ]
      });
    }

    if (command === "membercount") {
      const guild = await getGuild(TARGET_GUILD_ID);

      if (!guild) {
        return message.reply({
          embeds: [
            errorEmbed("SERVER UNAVAILABLE", "The destination server could not be found.")
          ]
        });
      }

      await guild.fetch().catch(() => {});

      return message.reply({
        embeds: [
          makeEmbed(
            "DESTINATION SERVER",
            `**Server:** ${guild.name}\n**Members:** ${guild.memberCount}`,
            COLORS.info
          )
        ]
      });
    }

    if (command === "whosflorian") {
      return message.reply({
        embeds: [
          makeEmbed(
            "COMMUNITY DATABASE",
            "**de goat**",
            COLORS.info
          )
        ]
      });
    }
  } catch (error) {
    console.error(`Prefix command ?${command} failed:`, error);

    return message.reply({
      embeds: [
        errorEmbed("COMMAND FAILED", "Something went wrong. Check the Railway deployment logs.")
      ]
    }).catch(() => {});
  }
});

client.on("guildMemberAdd", async member => {
  if (member.guild.id === TARGET_GUILD_ID) {
    const pending = state.pending[member.id];

    if (pending) {
      try {
        const role =
          member.guild.roles.cache.get(pending.roleId) ||
          member.guild.roles.cache.find(
            r => r.name.toLowerCase() === pending.roleName.toLowerCase()
          );

        if (role && role.position < member.guild.members.me.roles.highest.position) {
          await member.roles.add(role, "Pending trial rank assignment");
          delete state.pending[member.id];
          saveState();

          await sendLog(
            member.guild,
            successEmbed(
              "PENDING RANK ASSIGNED",
              `**Member:** ${member.user}\n**Rank:** ${role.name}`
            )
          );
        }
      } catch (error) {
        console.error("Pending rank assignment failed:", error.message);
      }
    }
  }

  if (!state.antiraid) return;

  const guild = member.guild;
  const now = Date.now();

  if (!state.joinTimes) state.joinTimes = {};
  const previous = (state.joinTimes[guild.id] || []).filter(t => now - t < 15000);
  previous.push(now);
  state.joinTimes[guild.id] = previous;
  saveState();

  if (previous.length >= 8) {
    await sendLog(
      guild,
      warningEmbed(
        "JOIN-BURST DETECTED",
        `**Server:** ${guild.name}\n**Recent joins:** ${previous.length} in 15 seconds\n**Action:** Alert logged. Review new members and server permissions.`
      )
    );

    state.joinTimes[guild.id] = [];
    saveState();
  }
});

async function handleNukeEvent(guild, type, targetId, description) {
  if (!state.antinuke) return;

  const now = Date.now();
  const actor = await getAuditExecutor(guild, type, targetId);

  const key = `${guild.id}:${actor?.id || "unknown"}`;
  const events = (state.nukeEvents[key] || []).filter(t => now - t < 30000);
  events.push(now);
  state.nukeEvents[key] = events;
  saveState();

  await sendLog(
    guild,
    warningEmbed(
      "ANTI-NUKE ALERT",
      [
        `**Event:** ${description}`,
        `**Server:** ${guild.name}`,
        `**Actor:** ${actor ? `${actor.tag} (${actor.id})` : "Unknown — audit log unavailable"}`,
        `**Events detected:** ${events.length} in 30 seconds`
      ].join("\n")
    )
  );

  if (!actor || actor.id === guild.ownerId || actor.id === client.user.id) return;
  if (events.length < 2) return;

  try {
    const member = await guild.members.fetch(actor.id).catch(() => null);
    if (!member || !guild.members.me) return;
    if (member.id === guild.ownerId) return;
    if (member.roles.highest.position >= guild.members.me.roles.highest.position) return;

    const dangerous = member.roles.cache.filter(role =>
      !role.managed &&
      role.id !== guild.id &&
      role.position < guild.members.me.roles.highest.position &&
      role.permissions.has([
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.ManageWebhooks
      ])
    );

    if (dangerous.size) {
      await member.roles.remove(dangerous, "Anti-nuke: repeated destructive actions detected");

      await sendLog(
        guild,
        errorEmbed(
          "ANTI-NUKE RESPONSE",
          `**Member:** ${member.user}\n**Action:** Removed manageable dangerous-permission roles.\n**Note:** This cannot undo deleted channels or other damage.`
        )
      );
    }
  } catch (error) {
    console.error("Anti-nuke response failed:", error.message);
  }
}

client.on("channelDelete", async channel => {
  if (!channel.guild) return;

  await handleNukeEvent(
    channel.guild,
    AuditLogEvent.ChannelDelete,
    channel.id,
    `Channel deleted: #${channel.name}`
  );
});

client.on("roleDelete", async role => {
  await handleNukeEvent(
    role.guild,
    AuditLogEvent.RoleDelete,
    role.id,
    `Role deleted: ${role.name}`
  );
});

client.on("webhookUpdate", async channel => {
  if (!channel.guild) return;

  await handleNukeEvent(
    channel.guild,
    AuditLogEvent.WebhookUpdate,
    null,
    `Webhooks updated in #${channel.name}`
  );
});

client.on("guildMemberAdd", async member => {
  if (!state.antinuke || !member.user.bot) return;

  const actor = await getAuditExecutor(
    member.guild,
    AuditLogEvent.BotAdd,
    member.id
  );

  await sendLog(
    member.guild,
    warningEmbed(
      "BOT ADDITION ALERT",
      [
        `**Bot added:** ${member.user}`,
        `**Added by:** ${actor ? actor.tag : "Unknown"}`,
        `**Server:** ${member.guild.name}`,
        "",
        "Review the bot's permissions and the inviter."
      ].join("\n")
    )
  );
});

client.on("error", error => {
  console.error("Discord client error:", error);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

client.login(TOKEN);
