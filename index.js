
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
  Events
} = require("discord.js");

const required = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "SOURCE_GUILD_ID",
  "TARGET_GUILD_ID",
  "TRIAL_RESULTS_CHANNEL_ID",
  "TARGET_INVITE_URL"
];

for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
}

const ranks = [
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

const dataFile =
  process.env.DATA_FILE || path.join(__dirname, "data", "pending.json");

fs.mkdirSync(path.dirname(dataFile), { recursive: true });

function loadPending() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    return {};
  }
}

let pending = loadPending();

function savePending() {
  const temp = `${dataFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(pending, null, 2));
  fs.renameSync(temp, dataFile);
}

function normalize(value) {
  return value.toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function findRank(input) {
  const query = normalize(input);
  if (!query) return { error: "Enter a rank name." };

  const exact = ranks.filter(r => normalize(r) === query);
  if (exact.length === 1) return { rank: exact[0] };

  const matches = ranks.filter(r => normalize(r).includes(query));

  if (matches.length === 1) return { rank: matches[0] };

  if (matches.length > 1) {
    return {
      error: `Multiple ranks match. Be more specific:\n${matches.join("\n")}`
    };
  }

  return { error: `Rank not found:\n${ranks.join("\n")}` };
}

function isAdmin(member) {
  return member?.permissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

const rankCommand = new SlashCommandBuilder()
  .setName("rank")
  .setDescription("Publish a trial result and rank a player.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Player being ranked")
      .setRequired(true))
  .addStringOption(o =>
    o.setName("role")
      .setDescription("Rank name; decorative symbols are optional")
      .setRequired(true)
      .setMaxLength(80));

const checkCommand = new SlashCommandBuilder()
  .setName("check")
  .setDescription("Check a player's rank in the destination server.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Player to check")
      .setRequired(true));

const promoteCommand = new SlashCommandBuilder()
  .setName("promote")
  .setDescription("Promote a member in the destination server.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Member to promote")
      .setRequired(true))
  .addStringOption(o =>
    o.setName("rank")
      .setDescription("New rank; decorative symbols are optional")
      .setRequired(true)
      .setMaxLength(80));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const rest = new REST({ version: "10" })
  .setToken(process.env.DISCORD_TOKEN);

client.once(Events.ClientReady, c => {
  console.log(`Logged in as ${c.user.tag}`);
});

// PREFIX COMMANDS
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim().toLowerCase();

  if (!["?membercount", "?whosflorian"].includes(content)) return;

  if (!isAdmin(message.member)) {
    return message.reply("You need Administrator permission to use this command.");
  }

  if (content === "?whosflorian") {
    return message.reply("de goat");
  }

  if (content === "?membercount") {
    const guild = await client.guilds
      .fetch(process.env.TARGET_GUILD_ID)
      .catch(() => null);

    if (!guild) {
      return message.reply("I can't access the destination server.");
    }

    try {
      const fullGuild = await guild.fetch();

      const embed = new EmbedBuilder()
        .setColor(0x202225)
        .setTitle("Server Member Count")
        .setDescription(
          `**Server:** ${fullGuild.name}\n` +
          `**Total Members:** ${fullGuild.memberCount.toLocaleString()}`
        )
        .setTimestamp();

      return message.reply({ embeds: [embed] });
    } catch {
      return message.reply("Couldn't retrieve the member count.");
    }
  }
});

// SLASH COMMANDS
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;

  if (!["rank", "check", "promote"].includes(i.commandName)) return;

  if (!i.inGuild() || !isAdmin(i.member)) {
    return i.reply({
      content: "Administrator permission is required to use this command.",
      ephemeral: true
    });
  }

  const user = i.options.getUser("user", true);

  // CHECK RANK
  if (i.commandName === "check") {
    await i.deferReply({ ephemeral: true });

    const guild = await client.guilds
      .fetch(process.env.TARGET_GUILD_ID)
      .catch(() => null);

    if (!guild) return i.editReply("I can't access the destination server.");

    const member = await guild.members.fetch(user.id).catch(() => null);

    if (!member) {
      return i.editReply("That player isn't in the destination server.");
    }

    const found = member.roles.cache
      .filter(role => ranks.some(r => normalize(r) === normalize(role.name)))
      .map(role => role.name);

    const embed = new EmbedBuilder()
      .setColor(0x202225)
      .setTitle("Rank Check")
      .setThumbnail(user.displayAvatarURL())
      .setDescription(
        `**Player:** ${user}\n` +
        `**Server:** ${guild.name}\n` +
        `**Rank:** ${found.length ? found.join(", ") : "Unranked"}`
      )
      .setTimestamp();

    return i.editReply({ embeds: [embed] });
  }

  // PROMOTE MEMBER IN DESTINATION SERVER
  if (i.commandName === "promote") {
    await i.deferReply({ ephemeral: true });

    const input = i.options.getString("rank", true);
    const result = findRank(input);

    if (result.error) return i.editReply(result.error);

    const guild = await client.guilds
      .fetch(process.env.TARGET_GUILD_ID)
      .catch(() => null);

    if (!guild) return i.editReply("I can't access the destination server.");

    const member = await guild.members.fetch(user.id).catch(() => null);

    if (!member) {
      return i.editReply("That player isn't in the destination server.");
    }

    const role = guild.roles.cache.find(
      r => normalize(r.name) === normalize(result.rank)
    );

    if (!role || role.managed || role.id === guild.id) {
      return i.editReply(`Create this rank role first:\n${result.rank}`);
    }

    const botMember = await guild.members.fetchMe();

    if (
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      botMember.roles.highest.comparePositionTo(role) <= 0
    ) {
      return i.editReply(
        "I need Manage Roles, and my highest role must be above the requested rank."
      );
    }

    if (member.id === guild.ownerId) {
      return i.editReply("The server owner cannot be promoted using this command.");
    }

    const previousRanks = member.roles.cache.filter(r =>
      ranks.some(name => normalize(name) === normalize(r.name))
    );

    try {
      // Replace the previous rank roles with the selected rank.
      await member.roles.remove(
        previousRanks,
        `Promoted by ${i.user.tag}`
      );

      await member.roles.add(role, `Promoted by ${i.user.tag}`);
    } catch (error) {
      console.error("Promotion failed:", error);
      return i.editReply(
        "Promotion failed. Check my Manage Roles permission and role hierarchy."
      );
    }

    const logEmbed = new EmbedBuilder()
      .setColor(0x202225)
      .setTitle("Rank Promotion Log")
      .setDescription(
        `**Player:** ${user} (\`${user.id}\`)\n` +
        `**Previous Rank(s):** ${previousRanks.size ? previousRanks.map(r => r.name).join(", ") : "Unranked"}\n` +
        `**New Rank:** ${role.name}\n` +
        `**Promoted By:** ${i.user}\n` +
        `**Server:** ${guild.name}`
      )
      .setTimestamp();

    // Optional: set RANK_LOG_CHANNEL_ID to a text channel ID in the destination server.
    if (process.env.RANK_LOG_CHANNEL_ID) {
      const logChannel = await guild.channels
        .fetch(process.env.RANK_LOG_CHANNEL_ID)
        .catch(() => null);

      if (logChannel?.isTextBased() && logChannel.send) {
        await logChannel.send({ embeds: [logEmbed] }).catch(console.error);
      }
    }

    await user.send(
      `You've been promoted to **${role.name}** in **${guild.name}**.`
    ).catch(() => {});

    return i.editReply(`Successfully promoted ${user} to **${role.name}**.`);
  }

  // RANK PLAYER FROM SOURCE SERVER
  if (i.commandName === "rank") {
    if (i.guildId !== process.env.SOURCE_GUILD_ID) {
      return i.reply({
        content: "Use this command in the configured source server.",
        ephemeral: true
      });
    }

    const input = i.options.getString("role", true);
    const result = findRank(input);

    if (result.error) {
      return i.reply({ content: result.error, ephemeral: true });
    }

    await i.deferReply({ ephemeral: true });

    const source = i.guild;
    const target = await client.guilds
      .fetch(process.env.TARGET_GUILD_ID)
      .catch(() => null);

    if (!target) return i.editReply("I can't access the destination server.");

    if (source.id === target.id) {
      return i.editReply("Source and destination servers must be different.");
    }

    const channel = await source.channels
      .fetch(process.env.TRIAL_RESULTS_CHANNEL_ID)
      .catch(() => null);

    if (!channel?.isTextBased() || !channel.send) {
      return i.editReply("I couldn't find the trial-results channel.");
    }

    const member = await source.members.fetch(user.id).catch(() => null);

    if (!member) return i.editReply("That player isn't in the source server.");

    if (user.id === i.user.id || user.id === source.ownerId) {
      return i.editReply("You can't rank-kick yourself or the server owner.");
    }

    const role = target.roles.cache.find(
      r => normalize(r.name) === normalize(result.rank)
    );

    if (!role || role.managed || role.id === target.id) {
      return i.editReply(`Create this destination role first:\n${result.rank}`);
    }

    const sourceBot = source.members.me;
    const targetBot = await target.members.fetchMe();

    if (!sourceBot?.permissions.has(PermissionFlagsBits.KickMembers)) {
      return i.editReply("I need Kick Members permission in the source server.");
    }

    if (member.roles.highest.comparePositionTo(sourceBot.roles.highest) >= 0) {
      return i.editReply("Move my highest role above the player in the source server.");
    }

    if (
      !targetBot.permissions.has(PermissionFlagsBits.ManageRoles) ||
      targetBot.roles.highest.comparePositionTo(role) <= 0
    ) {
      return i.editReply(
        "I need Manage Roles, with my highest role above the requested rank in the destination server."
      );
    }

    pending[user.id] = {
      rankName: role.name,
      roleId: role.id,
      createdAt: Date.now()
    };

    savePending();

    const dm = new EmbedBuilder()
      .setColor(0x202225)
      .setTitle("Rank Update")
      .setDescription(
        `You've been ranked to **${role.name}**.\n\n` +
        `Join the ranking server below to receive your role:\n` +
        process.env.TARGET_INVITE_URL
      )
      .setTimestamp();

    let dmSent = true;

    try {
      await user.send({ embeds: [dm] });
    } catch {
      dmSent = false;
    }

    const resultEmbed = new EmbedBuilder()
      .setColor(0x202225)
      .setTitle("Trial Results")
      .setDescription(
        `**Player:** ${user}\n` +
        `**Decision:** Successfully ranked\n` +
        `**New Rank:** ${role.name}\n` +
        `**Issued By:** ${i.user}\n\n` +
        `*The player has been invited to the ranking server to receive their role.*`
      )
      .setTimestamp();

    try {
      await channel.send({
        content: user.toString(),
        embeds: [resultEmbed],
        allowedMentions: { users: [user.id] }
      });
    } catch {
      delete pending[user.id];
      savePending();
      return i.editReply("I couldn't post the result. Nobody was kicked.");
    }

    try {
      await member.kick(`Ranked to ${role.name}.`);
    } catch {
      return i.editReply(
        "Result posted, but the kick failed. Check permissions and role hierarchy."
      );
    }

    return i.editReply(
      `Completed. Result posted, DM ${dmSent ? "sent" : "blocked"}, and player kicked from the source server. Their rank will be assigned when they join the destination server.`
    );
  }
});

// APPLY SAVED RANK WHEN A PLAYER JOINS DESTINATION SERVER
client.on(Events.GuildMemberAdd, async member => {
  if (member.guild.id !== process.env.TARGET_GUILD_ID) return;

  const assignment = pending[member.id];
  if (!assignment) return;

  const role =
    member.guild.roles.cache.get(assignment.roleId) ||
    member.guild.roles.cache.find(
      r => normalize(r.name) === normalize(assignment.rankName)
    );

  if (!role || role.managed || role.id === member.guild.id) return;

  const botMember = await member.guild.members.fetchMe();

  if (
    !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
    botMember.roles.highest.comparePositionTo(role) <= 0
  ) {
    console.error("Cannot assign pending rank: check permissions and role order.");
    return;
  }

  try {
    await member.roles.add(role, "Pending rank from trial results");

    delete pending[member.id];
    savePending();

    await member.send(
      `Your rank has been applied: **${role.name}**.`
    ).catch(() => {});

    console.log(`Assigned ${role.name} to ${member.user.tag}`);
  } catch (error) {
    console.error("Role assignment failed:", error.message);
  }
});

async function start() {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.SOURCE_GUILD_ID
    ),
    {
      body: [
        rankCommand.toJSON(),
        checkCommand.toJSON(),
        promoteCommand.toJSON()
      ]
    }
  );

  await client.login(process.env.DISCORD_TOKEN);
}

start().catch(error => {
  console.error("Bot startup failed:", error);
  process.exit(1);
});
