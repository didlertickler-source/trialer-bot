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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const SOURCE_ID = process.env.SOURCE_GUILD_ID;
const TARGET_ID = process.env.TARGET_GUILD_ID;
const RESULTS_ID = process.env.TRIAL_RESULTS_CHANNEL_ID;
const INVITE_URL = process.env.TARGET_INVITE_URL || "";
const LOG_ID =
  process.env.SECURITY_LOG_CHANNEL_ID ||
  process.env.RANK_LOG_CHANNEL_ID ||
  "";

const TRIALER_ROLE_NAME = "𓆩˙⸸˙𓆪︱trialer";
const DATA_FILE =
  process.env.DATA_FILE || path.join(__dirname, "data", "state.json");

if (!TOKEN || !CLIENT_ID || !SOURCE_ID || !TARGET_ID) {
  console.error("Missing Railway environment variables.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Channel,
    Partials.User,
    Partials.GuildMember
  ]
});

const C = {
  dark: 0x202127,
  green: 0x43b581,
  red: 0xed4245,
  yellow: 0xf0b232,
  blue: 0x5865f2
};

const defaults = {
  antiraid: false,
  antinuke: false,
  pending: {},
  spam: {},
  joins: {},
  nukeEvents: {},
  trials: {}
};

let state = Object.assign({}, defaults);

function loadState() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

    if (fs.existsSync(DATA_FILE)) {
      state = Object.assign(
        {},
        defaults,
        JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
      );
    } else {
      saveState();
    }
  } catch (error) {
    console.error("State loading failed:", error.message);
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

function makeEmbed(title, description, color) {
  return new EmbedBuilder()
    .setColor(color === undefined ? C.dark : color)
    .setTitle(title)
    .setDescription(description || "No additional details.")
    .setFooter({ text: "Server Management" })
    .setTimestamp();
}

function success(title, description) {
  return makeEmbed(title, description, C.green);
}

function failure(title, description) {
  return makeEmbed(title, description, C.red);
}

function warning(title, description) {
  return makeEmbed(title, description, C.yellow);
}

function information(title, description) {
  return makeEmbed(title, description, C.blue);
}

function isAdmin(member) {
  return Boolean(
    member &&
    member.permissions &&
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

function isTrialer(member) {
  if (!member) return false;

  return member.roles.cache.some(function (role) {
    return role.name === TRIALER_ROLE_NAME;
  });
}

async function defer(interaction, ephemeral) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      ephemeral: ephemeral !== false
    });
  }
}

async function replyEmbed(interaction, embed, ephemeral) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ embeds: [embed] });
    }

    return await interaction.reply({
      embeds: [embed],
      ephemeral: ephemeral !== false
    });
  } catch (error) {
    console.error("Interaction response failed:", error.message);
  }
}

async function adminOnly(interaction) {
  if (isAdmin(interaction.member)) return true;

  await replyEmbed(
    interaction,
    failure(
      "Permission denied",
      "You need Administrator permission to use this command."
    ),
    true
  );

  return false;
}

async function getGuild(id) {
  return client.guilds.fetch(id).catch(function () {
    return null;
  });
}

async function getMember(guild, id) {
  if (!guild) return null;

  return guild.members.fetch(id).catch(function () {
    return null;
  });
}

async function logToGuild(guild, e) {
  if (!guild) return;

  try {
    let channel = null;

    if (LOG_ID) {
      channel = await guild.channels.fetch(LOG_ID).catch(function () {
        return null;
      });
    }

    if (!channel) {
      channel = guild.channels.cache.find(function (ch) {
        return (
          ch.type === ChannelType.GuildText &&
          /logs|security|mod-log|audit/i.test(ch.name)
        );
      });
    }

    if (
      channel &&
      channel.isTextBased() &&
      channel.permissionsFor(guild.members.me) &&
      channel.permissionsFor(guild.members.me).has(
        PermissionFlagsBits.SendMessages
      )
    ) {
      await channel.send({ embeds: [e] });
    }
  } catch (error) {
    console.error("Log sending failed:", error.message);
  }
}

async function getAuditExecutor(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({
      type: type,
      limit: 6
    });

    const entry = logs.entries.find(function (item) {
      if (!item.executor || item.executor.bot) return false;
      if (Date.now() - item.createdTimestamp > 15000) return false;

      if (
        targetId &&
        item.target &&
        item.target.id !== targetId
      ) {
        return false;
      }

      return true;
    });

    return entry ? entry.executor : null;
  } catch (error) {
    return null;
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot latency"),

  new SlashCommandBuilder()
    .setName("antiraid")
    .setDescription("Enable or disable anti-raid monitoring")
    .addStringOption(function (option) {
      return option
        .setName("state")
        .setDescription("Protection state")
        .setRequired(true)
        .addChoices(
          { name: "on", value: "on" },
          { name: "off", value: "off" }
        );
    }),

  new SlashCommandBuilder()
    .setName("antinuke")
    .setDescription("Enable or disable anti-nuke monitoring")
    .addStringOption(function (option) {
      return option
        .setName("state")
        .setDescription("Protection state")
        .setRequired(true)
        .addChoices(
          { name: "on", value: "on" },
          { name: "off", value: "off" }
        );
    }),

  new SlashCommandBuilder()
    .setName("asktrial")
    .setDescription("Submit a request for a trial")
    .addStringOption(function (option) {
      return option
        .setName("robloxuser")
        .setDescription("Your Roblox username")
        .setRequired(true)
        .setMaxLength(50);
    })
    .addStringOption(function (option) {
      return option
        .setName("positionyouplay")
        .setDescription("The position you play")
        .setRequired(true)
        .setMaxLength(100);
    })
    .addIntegerOption(function (option) {
      return option
        .setName("activity")
        .setDescription("How active are you out of 10?")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(10);
    })
    .addStringOption(function (option) {
      return option
        .setName("areyougood")
        .setDescription("Do you think you're good?")
        .setRequired(true)
        .addChoices(
          { name: "Yes", value: "Yes" },
          { name: "Somewhat", value: "Somewhat" },
          { name: "Still improving", value: "Still improving" }
        );
    }),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Process a trial result using a rank name")
    .addUserOption(function (option) {
      return option
        .setName("user")
        .setDescription("Member to process")
        .setRequired(true);
    })
    .addStringOption(function (option) {
      return option
        .setName("rank")
        .setDescription("Type the destination rank name, e.g. starting")
        .setRequired(true)
        .setMaxLength(100);
    }),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Check a member's roles in the destination server")
    .addUserOption(function (option) {
      return option
        .setName("user")
        .setDescription("Member to check")
        .setRequired(true);
    }),

  new SlashCommandBuilder()
    .setName("promote")
    .setDescription("Change a member's rank in the destination server")
    .addUserOption(function (option) {
      return option
        .setName("user")
        .setDescription("Member to promote")
        .setRequired(true);
    })
    .addStringOption(function (option) {
      return option
        .setName("rank")
        .setDescription("Type the exact destination role name")
        .setRequired(true)
        .setMaxLength(100);
    }),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("View server information"),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("View user information")
    .addUserOption(function (option) {
      return option
        .setName("user")
        .setDescription("User to inspect")
        .setRequired(false);
    }),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("View a user's avatar")
    .addUserOption(function (option) {
      return option
        .setName("user")
        .setDescription("User to inspect")
        .setRequired(false);
    }),

  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("View role information")
    .addRoleOption(function (option) {
      return option
        .setName("role")
        .setDescription("Role to inspect")
        .setRequired(true);
    })
].map(function (command) {
  return command.toJSON();
});

async function registerCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, SOURCE_ID),
      { body: commands }
    );

    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Command registration failed:", error);
  }
}

client.once("ready", async function () {
  console.log("Logged in as " + client.user.tag);
  await registerCommands();
});

client.on("interactionCreate", async function (interaction) {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("claimtrial:")) {
        const requesterId = interaction.customId.split(":")[1];
        const trial = state.trials[requesterId];

        if (!trial || trial.status !== "open") {
          return replyEmbed(
            interaction,
            warning("Already handled", "This trial request has already been claimed or closed."),
            true
          );
        }

        if (!isAdmin(interaction.member) && !isTrialer(interaction.member)) {
          return replyEmbed(
            interaction,
            failure(
              "Permission denied",
              "Only trialers and administrators can claim trial requests."
            ),
            true
          );
        }

        await defer(interaction, true);

        trial.status = "claimed";
        trial.claimedBy = interaction.user.id;
        trial.claimedAt = Date.now();
        saveState();

        const requester = await client.users.fetch(requesterId).catch(function () {
          return null;
        });

        let dmSent = false;

        if (requester) {
          try {
            await requester.send({
              embeds: [
                information(
                  "Trial request claimed",
                  "Your trial request has been claimed by **" +
                    interaction.user.tag +
                    "**.\n\nPlease keep an eye on your DMs for further instructions."
                )
              ]
            });

            dmSent = true;
          } catch (error) {}
        }

        const claimedEmbed = success(
          "Trial request",
          "**Player:** <@" + requesterId + ">\n" +
          "**Roblox username:** " + trial.robloxuser + "\n" +
          "**Position:** " + trial.position + "\n" +
          "**Activity:** " + trial.activity + "/10\n" +
          "**Self-assessment:** " + trial.good + "\n\n" +
          "**Claimed by:** " + interaction.user +
          "\n**Status:** Claimed" +
          "\n**DM delivered:** " + (dmSent ? "Yes" : "No")
        );

        await interaction.message.edit({
          embeds: [claimedEmbed],
          components: []
        }).catch(function () {});

        await logToGuild(
          interaction.guild,
          information(
            "Trial claimed",
            "Player: <@" + requesterId + ">\nClaimed by: " +
              interaction.user.tag
          )
        );

        return replyEmbed(
          interaction,
          success(
            "Trial claimed",
            "You have claimed <@" + requesterId + "'s trial request.\n" +
              "DM: " + (dmSent ? "Sent" : "Could not be delivered") +
              "\n\nYou can now use `/rank` to process their result."
          ),
          true
        );
      }

      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;

    if (name === "ping") {
      await defer(interaction, false);

      return replyEmbed(
        interaction,
        success(
          "Pong",
          "WebSocket latency: `" + Math.round(client.ws.ping) + " ms`\nStatus: Online"
        ),
        false
      );
    }

    if (name === "serverinfo") {
      await defer(interaction, false);

      const guild = interaction.guild;

      if (!guild) {
        return replyEmbed(interaction, failure("Unavailable", "Use this command in a server."));
      }

      const e = information(
        "Server information",
        "**Name:** " + guild.name +
        "\n**ID:** `" + guild.id + "`" +
        "\n**Members:** " + guild.memberCount +
        "\n**Roles:** " + guild.roles.cache.size +
        "\n**Created:** <t:" + Math.floor(guild.createdTimestamp / 1000) + ":D>"
      );

      const icon = guild.iconURL({ size: 256 });
      if (icon) e.setThumbnail(icon);

      return replyEmbed(interaction, e, false);
    }

    await defer(interaction, true);

    if (!(await adminOnly(interaction))) return;

    if (name === "antiraid") {
      const enabled = interaction.options.getString("state") === "on";

      state.antiraid = enabled;
      saveState();

      await logToGuild(
        interaction.guild,
        information(
          "Anti-raid settings changed",
          "Changed by " + interaction.user.tag +
          "\nStatus: " + (enabled ? "Enabled" : "Disabled")
        )
      );

      return replyEmbed(
        interaction,
        makeEmbed(
          "Anti-raid",
          "Status: **" + (enabled ? "Enabled" : "Disabled") + "**\n\n" +
          (enabled
            ? "Message-spam detection and join-burst monitoring are active."
            : "Message-spam detection and join-burst monitoring are inactive."),
          enabled ? C.green : C.yellow
        )
      );
    }

    if (name === "antinuke") {
      const enabled = interaction.options.getString("state") === "on";

      state.antinuke = enabled;
      saveState();

      await logToGuild(
        interaction.guild,
        information(
          "Anti-nuke settings changed",
          "Changed by " + interaction.user.tag +
          "\nStatus: " + (enabled ? "Enabled" : "Disabled")
        )
      );

      return replyEmbed(
        interaction,
        makeEmbed(
          "Anti-nuke",
          "Status: **" + (enabled ? "Enabled" : "Disabled") + "**\n\n" +
          (enabled
            ? "Monitoring supported destructive actions."
            : "Anti-nuke monitoring is inactive."),
          enabled ? C.green : C.yellow
        )
      );
    }

    if (name === "asktrial") {
      const guild = interaction.guild;

      if (!guild) {
        return replyEmbed(interaction, failure("Unavailable", "Use this command in your server."));
      }

      const robloxuser = interaction.options.getString("robloxuser").trim();
      const position = interaction.options.getString("positionyouplay").trim();
      const activity = interaction.options.getInteger("activity");
      const good = interaction.options.getString("areyougood");

      if (state.trials[interaction.user.id] &&
          state.trials[interaction.user.id].status === "open") {
        return replyEmbed(
          interaction,
          warning(
            "Request already open",
            "You already have an unclaimed trial request. Wait for a trialer to claim it."
          ),
          true
        );
      }

      const trialerRole = guild.roles.cache.find(function (role) {
        return role.name === TRIALER_ROLE_NAME;
      });

      if (!trialerRole) {
        return replyEmbed(
          interaction,
          failure(
            "Trial role not found",
            "Create the role named " + TRIALER_ROLE_NAME + " in this server first."
          ),
          true
        );
      }

      const trialEmbed = makeEmbed(
        "Trial request",
        "**Player:** " + interaction.user + "\n" +
        "**Roblox username:** " + robloxuser + "\n" +
        "**Position:** " + position + "\n" +
        "**Activity:** " + activity + "/10\n" +
        "**Are you good?** " + good + "\n\n" +
        "**Status:** Waiting to be claimed",
        C.dark
      );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("claimtrial:" + interaction.user.id)
          .setLabel("Claim")
          .setStyle(ButtonStyle.Secondary)
      );

      const destination =
        RESULTS_ID
          ? await guild.channels.fetch(RESULTS_ID).catch(function () {
              return null;
            })
          : interaction.channel;

      if (!destination || !destination.isTextBased()) {
        return replyEmbed(
          interaction,
          failure(
            "Channel unavailable",
            "The configured trial-results channel could not be found. Check TRIAL_RESULTS_CHANNEL_ID in Railway."
          ),
          true
        );
      }

      state.trials[interaction.user.id] = {
        userId: interaction.user.id,
        robloxuser: robloxuser,
        position: position,
        activity: activity,
        good: good,
        status: "open",
        createdAt: Date.now(),
        messageId: null,
        channelId: destination.id,
        guildId: guild.id
      };

      saveState();

      try {
        const posted = await destination.send({
          content: trialerRole.toString(),
          embeds: [trialEmbed],
          components: [row],
          allowedMentions: { roles: [trialerRole.id] }
        });

        state.trials[interaction.user.id].messageId = posted.id;
        saveState();
      } catch (error) {
        delete state.trials[interaction.user.id];
        saveState();

        return replyEmbed(
          interaction,
          failure(
            "Request could not be posted",
            "Check the bot's Send Messages and Embed Links permissions in the trial-results channel."
          ),
          true
        );
      }

      return replyEmbed(
        interaction,
        success(
          "Trial request submitted",
          "Your request has been posted and the trialers have been notified.\n\nYou will receive a DM when someone claims it."
        ),
        true
      );
    }

    if (name === "rank") {
      const user = interaction.options.getUser("user");
      const rankName = interaction.options.getString("rank").trim();

      const source = await getGuild(SOURCE_ID);
      const target = await getGuild(TARGET_ID);

      if (!source || !target) {
        return replyEmbed(
          interaction,
          failure("Server unavailable", "The bot must be in both configured servers.")
        );
      }

      const sourceMember = await getMember(source, user.id);

      if (!sourceMember) {
        return replyEmbed(
          interaction,
          failure("Member not found", "That user is not in the source server.")
        );
      }

      const role = target.roles.cache.find(function (item) {
        return item.name.toLowerCase() === rankName.toLowerCase();
      });

      if (!role) {
        return replyEmbed(
          interaction,
          failure(
            "Rank not found",
            "There is no role named **" + rankName +
            "** in the destination server. Check the spelling and try again."
          )
        );
      }

      state.pending[user.id] = {
        roleId: role.id,
        roleName: role.name,
        issuedAt: Date.now()
      };

      saveState();

      let dmSent = false;

      try {
        await user.send({
          embeds: [
            success(
              "Trial result",
              "Your trial result has been processed.\n\n**Rank:** " +
              role.name + "\n\n" +
              (INVITE_URL
                ? "**Destination server:** " + INVITE_URL
                : "Contact staff for the destination server invite.")
            )
          ]
        });

        dmSent = true;
      } catch (error) {}

      if (RESULTS_ID) {
        const channel = await source.channels.fetch(RESULTS_ID).catch(function () {
          return null;
        });

        if (channel && channel.isTextBased()) {
          await channel.send({
            embeds: [
              information(
                "Trial result",
                "**Member:** " + user.tag +
                "\n**Rank:** " + role.name +
                "\n**Processed by:** " + interaction.user.tag
              )
            ]
          }).catch(function () {});
        }
      }

      let kicked = false;

      try {
        if (sourceMember.kickable) {
          await sourceMember.kick("Trial result processed by " + interaction.user.tag);
          kicked = true;
        }
      } catch (error) {
        console.error("Kick failed:", error.message);
      }

      if (state.trials[user.id]) {
        state.trials[user.id].status = "ranked";
        state.trials[user.id].rankName = role.name;
        state.trials[user.id].rankedBy = interaction.user.id;
        saveState();
      }

      await logToGuild(
        source,
        information(
          "Rank action",
          "**Member:** " + user.tag +
          "\n**Rank:** " + role.name +
          "\n**DM sent:** " + (dmSent ? "Yes" : "No") +
          "\n**Removed from source:** " + (kicked ? "Yes" : "No")
        )
      );

      return replyEmbed(
        interaction,
        makeEmbed(
          "Trial processed",
          "**Member:** " + user.tag +
          "\n**Destination rank:** " + role.name +
          "\n**DM:** " + (dmSent ? "Sent" : "Could not be delivered") +
          "\n**Source removal:** " + (kicked ? "Completed" : "Not completed") +
          "\n\nRank assignment is pending until the member joins the destination server.",
          kicked ? C.green : C.yellow
        )
      );
    }

    if (name === "check") {
      const user = interaction.options.getUser("user");
      const target = await getGuild(TARGET_ID);

      if (!target) {
        return replyEmbed(interaction, failure("Unavailable", "Destination server not found."));
      }

      const member = await getMember(target, user.id);

      if (!member) {
        return replyEmbed(
          interaction,
          warning("Member not found", user.tag + " is not in the destination server.")
        );
      }

      const roles = member.roles.cache
        .filter(function (role) {
          return role.id !== target.id;
        })
        .sort(function (a, b) {
          return b.position - a.position;
        })
        .map(function (role) {
          return "• " + role.name;
        });

      return replyEmbed(
        interaction,
        information(
          "Member roles",
          "**Member:** " + user.tag + "\n**ID:** `" + user.id + "`\n\n" +
          (roles.length ? roles.join("\n") : "No roles assigned.")
        )
      );
    }

    if (name === "promote") {
      const user = interaction.options.getUser("user");
      const rankName = interaction.options.getString("rank").trim();
      const target = await getGuild(TARGET_ID);

      if (!target || !target.members.me) {
        return replyEmbed(interaction, failure("Unavailable", "Destination server not found."));
      }

      const member = await getMember(target, user.id);

      if (!member) {
        return replyEmbed(
          interaction,
          warning("Member not found", "That user is not in the destination server.")
        );
      }

      const role = target.roles.cache.find(function (item) {
        return item.name.toLowerCase() === rankName.toLowerCase();
      });

      if (!role) {
        return replyEmbed(
          interaction,
          failure("Rank not found", "No role matches **" + rankName + "**.")
        );
      }

      if (
        role.managed ||
        role.position >= target.members.me.roles.highest.position
      ) {
        return replyEmbed(
          interaction,
          failure(
            "Role hierarchy",
            "Move the bot's highest role above the target rank and try again."
          )
        );
      }

      const rankKeywords = [
        "trial", "reserve", "reserves", "academy",
        "starter", "captain", "player", "member", "starting"
      ];

      const oldRoles = member.roles.cache.filter(function (item) {
        return (
          item.id !== target.id &&
          !item.managed &&
          item.position < target.members.me.roles.highest.position &&
          rankKeywords.some(function (keyword) {
            return item.name.toLowerCase().includes(keyword);
          })
        );
      });

      try {
        if (oldRoles.size) await member.roles.remove(oldRoles);
        await member.roles.add(role);
      } catch (error) {
        return replyEmbed(interaction, failure("Update failed", error.message));
      }

      await logToGuild(
        target,
        information(
          "Rank changed",
          "**Member:** " + user.tag +
          "\n**New rank:** " + role.name +
          "\n**Changed by:** " + interaction.user.tag
        )
      );

      try {
        await user.send({
          embeds: [
            success(
              "Rank updated",
              "Your rank is now **" + role.name + "** in **" + target.name + "**."
            )
          ]
        });
      } catch (error) {}

      return replyEmbed(
        interaction,
        success("Rank updated", "**Member:** " + user.tag + "\n**New rank:** " + role.name)
      );
    }

    if (name === "userinfo") {
      const user = interaction.options.getUser("user") || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(function () {
        return null;
      });

      const e = information(
        "User information",
        "**User:** " + user.tag +
        "\n**ID:** `" + user.id + "`" +
        "\n**Created:** <t:" + Math.floor(user.createdTimestamp / 1000) + ":F>" +
        "\n**Joined:** " +
        (member && member.joinedTimestamp
          ? "<t:" + Math.floor(member.joinedTimestamp / 1000) + ":F>"
          : "Not a member")
      ).setThumbnail(user.displayAvatarURL({ size: 256 }));

      return replyEmbed(interaction, e, false);
    }

    if (name === "avatar") {
      const user = interaction.options.getUser("user") || interaction.user;
      const avatar = user.displayAvatarURL({ size: 1024 });

      return replyEmbed(
        interaction,
        information("Avatar", "[Open full-size avatar](" + avatar + ")").setImage(avatar),
        false
      );
    }

    if (name === "roleinfo") {
      const role = interaction.options.getRole("role");

      return replyEmbed(
        interaction,
        information(
          "Role information",
          "**Role:** " + role.name +
          "\n**ID:** `" + role.id + "`" +
          "\n**Color:** `" + role.hexColor + "`" +
          "\n**Members:** " + role.members.size +
          "\n**Position:** " + role.position +
          "\n**Mentionable:** " + (role.mentionable ? "Yes" : "No") +
          "\n**Created:** <t:" + Math.floor(role.createdTimestamp / 1000) + ":F>"
        ),
        false
      );
    }
  } catch (error) {
    console.error("Interaction failed:", error);

    await replyEmbed(
      interaction,
      failure(
        "Command failed",
        "The command could not be completed. Check the Railway deployment logs."
      )
    );
  }
});

client.on("messageCreate", async function (message) {
  if (!message.guild || message.author.bot) return;

  if (state.antiraid) {
    const now = Date.now();
    const key = message.guild.id + ":" + message.author.id;
    const recent = (state.spam[key] || []).filter(function (time) {
      return now - time < 6000;
    });

    recent.push(now);
    state.spam[key] = recent;

    if (recent.length >= 6) {
      const member = message.member;

      if (member && !isAdmin(member) && member.moderatable) {
        try {
          await member.timeout(60000, "Anti-raid: message spam");

          await logToGuild(
            message.guild,
            warning(
              "Spam detected",
              "**Member:** " + message.author.tag +
              "\n**Action:** 60-second timeout"
            )
          );
        } catch (error) {
          console.error("Timeout failed:", error.message);
        }
      }

      state.spam[key] = [];
    }
  }

  if (!message.content.startsWith("?")) return;

  const parts = message.content.slice(1).trim().split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();

  if (!["ping", "membercount", "whosflorian"].includes(command)) return;

  if (!isAdmin(message.member)) {
    return message.reply({
      embeds: [
        failure("Permission denied", "Administrator permission is required.")
      ]
    }).catch(function () {});
  }

  try {
    if (command === "ping") {
      return message.reply({
        embeds: [
          success(
            "Pong",
            "WebSocket latency: `" + Math.round(client.ws.ping) + " ms`"
          )
        ]
      });
    }

    if (command === "membercount") {
      const target = await getGuild(TARGET_ID);

      if (!target) {
        return message.reply({
          embeds: [failure("Unavailable", "Destination server not found.")]
        });
      }

      return message.reply({
        embeds: [
          information(
            "Member count",
            "**Server:** " + target.name + "\n**Members:** " + target.memberCount
          )
        ]
      });
    }

    if (command === "whosflorian") {
      return message.reply({
        embeds: [information("Florian", "de goat")]
      });
    }
  } catch (error) {
    console.error("Prefix command failed:", error);

    return message.reply({
      embeds: [failure("Command failed", "Check Railway deployment logs.")]
    }).catch(function () {});
  }
});

client.on("guildMemberAdd", async function (member) {
  if (member.guild.id === TARGET_ID && state.pending[member.id]) {
    const pending = state.pending[member.id];

    try {
      const role =
        member.guild.roles.cache.get(pending.roleId) ||
        member.guild.roles.cache.find(function (item) {
          return item.name.toLowerCase() === pending.roleName.toLowerCase();
        });

      if (
        role &&
        member.guild.members.me &&
        role.position < member.guild.members.me.roles.highest.position
      ) {
        await member.roles.add(role, "Pending trial rank assignment");

        delete state.pending[member.id];
        saveState();

        await logToGuild(
          member.guild,
          success("Rank assigned", member.user.tag + " received " + role.name + ".")
        );
      }
    } catch (error) {
      console.error("Pending rank assignment failed:", error.message);
    }
  }

  if (state.antiraid) {
    const now = Date.now();
    const key = member.guild.id;

    const recent = (state.joins[key] || []).filter(function (time) {
      return now - time < 15000;
    });

    recent.push(now);
    state.joins[key] = recent;
    saveState();

    if (recent.length >= 8) {
      await logToGuild(
        member.guild,
        warning(
          "Join burst detected",
          recent.length + " members joined within 15 seconds. Review recent accounts."
        )
      );

      state.joins[key] = [];
      saveState();
    }
  }

  if (state.antinuke && member.user.bot) {
    const actor = await getAuditExecutor(
      member.guild,
      AuditLogEvent.BotAdd,
      member.id
    );

    await logToGuild(
      member.guild,
      warning(
        "Bot added",
        "**Bot:** " + member.user.tag +
        "\n**Added by:** " + (actor ? actor.tag : "Unknown") +
        "\nReview the bot's permissions."
      )
    );
  }
});

async function handleDestructiveEvent(guild, type, targetId, description) {
  if (!state.antinuke) return;

  const actor = await getAuditExecutor(guild, type, targetId);
  const key = guild.id + ":" + (actor ? actor.id : "unknown");

  const recent = (state.nukeEvents[key] || []).filter(function (time) {
    return Date.now() - time < 30000;
  });

  recent.push(Date.now());
  state.nukeEvents[key] = recent;
  saveState();

  await logToGuild(
    guild,
    warning(
      "Anti-nuke alert",
      "**Event:** " + description +
      "\n**Actor:** " + (actor ? actor.tag : "Unknown") +
      "\n**Recent events:** " + recent.length + " in 30 seconds"
    )
  );

  if (!actor || actor.id === guild.ownerId || recent.length < 2) return;

  try {
    const member = await guild.members.fetch(actor.id).catch(function () {
      return null;
    });

    if (!member || !guild.members.me) return;

    if (
      member.roles.highest.position >=
      guild.members.me.roles.highest.position
    ) {
      return;
    }

    const dangerousPermissions = [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.ManageWebhooks
    ];

    const dangerousRoles = member.roles.cache.filter(function (role) {
      return (
        role.id !== guild.id &&
        !role.managed &&
        role.position < guild.members.me.roles.highest.position &&
        dangerousPermissions.some(function (permission) {
          return role.permissions.has(permission);
        })
      );
    });

    if (dangerousRoles.size) {
      await member.roles.remove(
        dangerousRoles,
        "Anti-nuke: repeated destructive actions"
      );

      await logToGuild(
        guild,
        failure(
          "Anti-nuke response",
          "Removed manageable dangerous-permission roles from " + actor.tag + "."
        )
      );
    }
  } catch (error) {
    console.error("Anti-nuke response failed:", error.message);
  }
}

client.on("channelDelete", async function (channel) {
  if (!channel.guild) return;

  await handleDestructiveEvent(
    channel.guild,
    AuditLogEvent.ChannelDelete,
    channel.id,
    "Channel deleted: " + channel.name
  );
});

client.on("roleDelete", async function (role) {
  await handleDestructiveEvent(
    role.guild,
    AuditLogEvent.RoleDelete,
    role.id,
    "Role deleted: " + role.name
  );
});

client.on("webhookUpdate", async function (channel) {
  if (!channel.guild) return;

  await handleDestructiveEvent(
    channel.guild,
    AuditLogEvent.WebhookUpdate,
    null,
    "Webhooks updated in #" + channel.name
  );
});

client.on("error", function (error) {
  console.error("Discord client error:", error);
});

process.on("unhandledRejection", function (error) {
  console.error("Unhandled rejection:", error);
});

client.login(TOKEN);
