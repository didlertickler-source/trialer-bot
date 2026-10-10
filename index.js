from pathlib import Path
p = Path("/mnt/data/index.js")
code = r'''require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, Events, AuditLogEvent, ChannelType
} = require("discord.js");

const required = [
  "DISCORD_TOKEN", "CLIENT_ID", "SOURCE_GUILD_ID",
  "TARGET_GUILD_ID", "TRIAL_RESULTS_CHANNEL_ID", "TARGET_INVITE_URL"
];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
}

const RANKS = [
  "𓆩˙⸸˙𓆪︱top 1", "𓆩˙⸸˙𓆪︱top 3",
  "𓆩˙⸸˙𓆪︱top 15", "𓆩˙⸸˙𓆪︱best",
  "𓆩˙⸸˙𓆪︱starting xi", "𓆩˙⸸˙𓆪︱main bench",
  "𓆩˙⸸˙𓆪︱team A", "𓆩˙⸸˙𓆪︱team B",
  "𓆩˙⸸˙𓆪︱team C", "𓆩˙⸸˙𓆪︱team D"
];

const dataFile = process.env.DATA_FILE || path.join(__dirname, "data", "bot-state.json");
fs.mkdirSync(path.dirname(dataFile), { recursive: true });

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    return {
      pending: s.pending || {},
      settings: s.settings || {},
      strikes: s.strikes || {}
    };
  } catch {
    return { pending: {}, settings: {}, strikes: {} };
  }
}
const state = readState();
function saveState() {
  const temp = `${dataFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, dataFile);
}
function normalize(s) {
  return String(s).toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}
function findRank(input) {
  const q = normalize(input);
  if (!q) return { error: "Enter a rank name." };
  const exact = RANKS.filter(r => normalize(r) === q);
  if (exact.length === 1) return { rank: exact[0] };
  const matches = RANKS.filter(r => normalize(r).includes(q));
  if (matches.length === 1) return { rank: matches[0] };
  if (matches.length > 1) return { error: `Ambiguous rank. Use one of:\n${matches.join("\n")}` };
  return { error: `Rank not found. Available ranks:\n${RANKS.join("\n")}` };
}
function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
}
function setting(guildId) {
  if (!state.settings[guildId]) state.settings[guildId] = { antiraid: false, antinuke: false };
  return state.settings[guildId];
}

const adminDefault = PermissionFlagsBits.Administrator;
const rankCommand = new SlashCommandBuilder()
  .setName("rank").setDescription("Publish a trial result and rank a player.")
  .setDefaultMemberPermissions(adminDefault)
  .addUserOption(o => o.setName("user").setDescription("Player being ranked").setRequired(true))
  .addStringOption(o => o.setName("role").setDescription("Rank name; symbols are optional").setRequired(true).setMaxLength(80));

const checkCommand = new SlashCommandBuilder()
  .setName("check").setDescription("Check a player's rank in the destination server.")
  .setDefaultMemberPermissions(adminDefault)
  .addUserOption(o => o.setName("user").setDescription("Player to check").setRequired(true));

const promoteCommand = new SlashCommandBuilder()
  .setName("promote").setDescription("Set a member's rank in the destination server.")
  .setDefaultMemberPermissions(adminDefault)
  .addUserOption(o => o.setName("user").setDescription("Member to promote").setRequired(true))
  .addStringOption(o => o.setName("rank").setDescription("New rank; symbols are optional").setRequired(true).setMaxLength(80));

function toggleCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name).setDescription(description)
    .setDefaultMemberPermissions(adminDefault)
    .addStringOption(o => o.setName("state").setDescription("Enable or disable the protection")
      .setRequired(true)
      .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }));
}
const antiRaidCommand = toggleCommand("antiraid", "Toggle anti-raid protection.");
const antiNukeCommand = toggleCommand("antinuke", "Toggle anti-nuke monitoring.");

const utilityCommands = [
  new SlashCommandBuilder().setName("ping").setDescription("Check the bot's latency."),
  new SlashCommandBuilder().setName("serverinfo").setDescription("Show information about this server."),
  new SlashCommandBuilder().setName("userinfo").setDescription("Show information about a user.")
    .addUserOption(o => o.setName("user").setDescription("User to inspect").setRequired(false)),
  new SlashCommandBuilder().setName("avatar").setDescription("Show a user's avatar.")
    .addUserOption(o => o.setName("user").setDescription("User whose avatar to show").setRequired(false)),
  new SlashCommandBuilder().setName("roleinfo").setDescription("Show information about a role.")
    .addRoleOption(o => o.setName("role").setDescription("Role to inspect").setRequired(true))
];
const commands = [
  rankCommand, checkCommand, promoteCommand, antiRaidCommand, antiNukeCommand,
  ...utilityCommands
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function sendLog(guild, title, description, color = 0x202225) {
  const channelId = process.env.SECURITY_LOG_CHANNEL_ID || process.env.RANK_LOG_CHANNEL_ID;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased() && channel.send) {
    await channel.send({
      embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp()]
    }).catch(() => {});
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
        { reason: `Anti-raid ${enabled ? "enabled" : "disabled"}` }
      );
      changed++;
    } catch (e) {
      console.error(`Couldn't update external-app permission for ${channel.name}: ${e.message}`);
    }
  }
  return changed;
}

client.once(Events.ClientReady, c => console.log(`Logged in as ${c.user.tag}`));

// Prefix utilities and anti-raid spam detection.
const messageHits = new Map();
const joinHits = new Map();

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;

  const text = message.content.trim().toLowerCase();
  if (["?membercount", "?whosflorian"].includes(text)) {
    if (!isAdmin(message.member)) {
      return message.reply("Administrator permission is required.").catch(() => {});
    }
    if (text === "?whosflorian") return message.reply("de goat").catch(() => {});
    const guild = await client.guilds.fetch(process.env.TARGET_GUILD_ID).catch(() => null);
    if (!guild) return message.reply("I can't access the destination server.").catch(() => {});
    const full = await guild.fetch().catch(() => null);
    return message.reply(`**${full?.name || guild.name}** has **${(full?.memberCount ?? guild.memberCount ?? 0).toLocaleString()}** members.`).catch(() => {});
  }

  const cfg = setting(message.guild.id);
  if (!cfg.antiraid) return;

  const now = Date.now();
  const key = `${message.guild.id}:${message.author.id}`;
  const recent = (messageHits.get(key) || []).filter(t => now - t < 6000);
  recent.push(now);
  messageHits.set(key, recent);

  if (recent.length >= 6) {
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member && !isAdmin(member) && member.moderatable) {
      await member.timeout(60_000, "Anti-raid: message spam detected").catch(() => {});
      await sendLog(message.guild, "Anti-Raid: Spam Timeout",
        `**Member:** ${message.author} (\`${message.author.id}\`)\n**Action:** 60-second timeout\n**Reason:** 6 messages within 6 seconds.`,
        0xE67E22);
      messageHits.delete(key);
    }
  }
});

client.on(Events.GuildMemberAdd, async member => {
  const cfg = setting(member.guild.id);
  if (!cfg.antiraid) return;

  const now = Date.now();
  const hits = (joinHits.get(member.guild.id) || []).filter(t => now - t < 15_000);
  hits.push(now);
  joinHits.set(member.guild.id, hits);

  if (hits.length >= 8) {
    await sendLog(member.guild, "Anti-Raid: Join Burst",
      `**Alert:** ${hits.length} members joined within 15 seconds.\nReview recent joins and enable Discord's built-in Raid Protection if available.`,
      0xE67E22);
  }
});

// Anti-nuke audit log monitoring. It alerts and strips dangerous permissions from
// a non-owner actor where possible; it does not claim to undo deleted channels.
const destructiveEvents = [
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.WebhookCreate,
  AuditLogEvent.BotAdd
];
const auditHits = new Map();

async function protectFromNuke(guild, eventType, label) {
  const cfg = setting(guild.id);
  if (!cfg.antinuke) return;

  try {
    const logs = await guild.fetchAuditLogs({ type: eventType, limit: 1 });
    const entry = logs.entries.first();
    if (!entry || Date.now() - entry.createdTimestamp > 12_000 || !entry.executor) return;
    if (entry.executor.id === client.user.id || entry.executor.id === guild.ownerId) return;

    const now = Date.now();
    const key = `${guild.id}:${entry.executor.id}`;
    const hits = (auditHits.get(key) || []).filter(t => now - t < 30_000);
    hits.push(now);
    auditHits.set(key, hits);

    await sendLog(guild, "Anti-Nuke Alert",
      `**Action:** ${label}\n**Actor:** ${entry.executor} (\`${entry.executor.id}\`)\n**Recent destructive actions:** ${hits.length}`,
      0xE74C3C);

    if (hits.length >= 2) {
      const actor = await guild.members.fetch(entry.executor.id).catch(() => null);
      if (actor && actor.id !== guild.ownerId && actor.manageable) {
        const dangerous = [
          PermissionFlagsBits.Administrator,
          PermissionFlagsBits.ManageGuild,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.ManageWebhooks,
          PermissionFlagsBits.KickMembers,
          PermissionFlagsBits.BanMembers
        ];
        for (const role of actor.roles.cache.values()) {
          if (role.managed || role.id === guild.id) continue;
          if (role.permissions.any(dangerous)) {
            await role.setPermissions(
              role.permissions.remove(dangerous),
              `Anti-nuke response after repeated destructive actions by ${entry.executor.tag}`
            ).catch(() => {});
          }
        }
        await sendLog(guild, "Anti-Nuke Response",
          `Attempted to remove dangerous permissions from **${entry.executor.tag}** after repeated destructive actions.`,
          0xC0392B);
      }
    }
  } catch (e) {
    console.error(`Anti-nuke audit check failed (${label}): ${e.message}`);
  }
}

client.on(Events.ChannelDelete, channel => {
  if (channel.guild) protectFromNuke(channel.guild, AuditLogEvent.ChannelDelete, `Channel deleted: ${channel.name}`);
});
client.on(Events.RoleDelete, role => {
  protectFromNuke(role.guild, AuditLogEvent.RoleDelete, `Role deleted: ${role.name}`);
});
client.on(Events.WebhooksUpdate, channel => {
  protectFromNuke(channel.guild, AuditLogEvent.WebhookCreate, `Webhook update in #${channel.name}`);
});
client.on(Events.GuildMemberAdd, member => {
  if (member.user.bot) protectFromNuke(member.guild, AuditLogEvent.BotAdd, `Bot added: ${member.user.tag}`);
});

client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;

  const name = i.commandName;

  if (["rank", "check", "promote", "antiraid", "antinuke"].includes(name)) {
    if (!i.inGuild() || !isAdmin(i.member)) {
      return i.reply({ content: "Administrator permission is required.", ephemeral: true });
    }
  }

  if (name === "ping") {
    return i.reply({ content: `Pong! WebSocket latency: **${client.ws.ping}ms**`, ephemeral: true });
  }

  if (name === "serverinfo") {
    if (!i.guild) return i.reply({ content: "Use this in a server.", ephemeral: true });
    const g = await i.guild.fetch();
    const embed = new EmbedBuilder().setColor(0x202225).setTitle(g.name)
      .setThumbnail(g.iconURL())
      .setDescription(
        `**Members:** ${g.memberCount.toLocaleString()}\n` +
        `**Created:** <t:${Math.floor(g.createdTimestamp / 1000)}:D>\n` +
        `**Owner ID:** ${g.ownerId}\n**Channels:** ${g.channels.cache.size}\n**Roles:** ${g.roles.cache.size}`
      ).setTimestamp();
    return i.reply({ embeds: [embed], ephemeral: true });
  }

  if (name === "userinfo") {
    const user = i.options.getUser("user") || i.user;
    const member = i.guild ? await i.guild.members.fetch(user.id).catch(() => null) : null;
    const embed = new EmbedBuilder().setColor(0x202225).setTitle("User Information")
      .setThumbnail(user.displayAvatarURL())
      .setDescription(
        `**User:** ${user}\n**ID:** \`${user.id}\`\n` +
        `**Account Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:F>\n` +
        `**Joined Server:** ${member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : "Not a member"}\n` +
        `**Roles:** ${member ? member.roles.cache.filter(r => r.id !== i.guild.id).map(r => r.name).join(", ") || "None" : "Unavailable"}`
      );
    return i.reply({ embeds: [embed], ephemeral: true });
  }

  if (name === "avatar") {
    const user = i.options.getUser("user") || i.user;
    const embed = new EmbedBuilder().setColor(0x202225).setTitle(`${user.username}'s Avatar`)
      .setImage(user.displayAvatarURL({ size: 1024 }));
    return i.reply({ embeds: [embed], ephemeral: true });
  }

  if (name === "roleinfo") {
    const role = i.options.getRole("role", true);
    const embed = new EmbedBuilder().setColor(role.color || 0x202225).setTitle("Role Information")
      .setDescription(
        `**Role:** ${role}\n**ID:** \`${role.id}\`\n**Members:** ${role.members.size}\n` +
        `**Position:** ${role.position}\n**Mentionable:** ${role.mentionable ? "Yes" : "No"}\n` +
        `**Created:** <t:${Math.floor(role.createdTimestamp / 1000)}:D>`
      );
    return i.reply({ embeds: [embed], ephemeral: true });
  }

  if (name === "antiraid" || name === "antinuke") {
    const enabled = i.options.getString("state", true) === "on";
    const cfg = setting(i.guild.id);

    if (name === "antiraid") {
      cfg.antiraid = enabled;
      saveState();
      let detail = "";
      if (enabled) {
        const changed = await setExternalApps(i.guild, true);
        detail = `\nExternal-app permissions denied in ${changed} accessible channels.`;
      } else {
        detail = "\nExternal-app permission overwrites were left in place for safety; restore them manually if needed.";
      }
      await sendLog(i.guild, "Anti-Raid Configuration",
        `**Changed by:** ${i.user}\n**Status:** ${enabled ? "Enabled" : "Disabled"}${detail}`,
        enabled ? 0x2ECC71 : 0x95A5A6);
      return i.reply({
        content: `Anti-raid **${enabled ? "enabled" : "disabled"}**.${detail}`,
        ephemeral: true
      });
    }

    cfg.antinuke = enabled;
    saveState();
    await sendLog(i.guild, "Anti-Nuke Configuration",
      `**Changed by:** ${i.user}\n**Status:** ${enabled ? "Enabled" : "Disabled"}`,
      enabled ? 0x2ECC71 : 0x95A5A6);
    return i.reply({
      content: `Anti-nuke monitoring **${enabled ? "enabled" : "disabled"}**. It monitors destructive audit-log events and attempts a permission response to repeated actions.`,
      ephemeral: true
    });
  }

  if (name === "check") {
    await i.deferReply({ ephemeral: true });
    const user = i.options.getUser("user", true);
    const guild = await client.guilds.fetch(process.env.TARGET_GUILD_ID).catch(() => null);
    if (!guild) return i.editReply("I can't access the destination server.");
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return i.editReply("That player isn't in the destination server.");
    const found = member.roles.cache.filter(role =>
      RANKS.some(r => normalize(r) === normalize(role.name))
    ).map(role => role.name);
    const embed = new EmbedBuilder().setColor(0x202225).setTitle("Rank Check")
      .setThumbnail(user.displayAvatarURL())
      .setDescription(`**Player:** ${user}\n**Server:** ${guild.name}\n**Rank:** ${found.join(", ") || "Unranked"}`)
      .setTimestamp();
    return i.editReply({ embeds: [embed] });
  }

  if (name === "promote") {
    await i.deferReply({ ephemeral: true });
    const user = i.options.getUser("user", true);
    const result = findRank(i.options.getString("rank", true));
    if (result.error) return i.editReply(result.error);

    const guild = await client.guilds.fetch(process.env.TARGET_GUILD_ID).catch(() => null);
    if (!guild) return i.editReply("I can't access the destination server.");
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return i.editReply("That player isn't in the destination server.");

    const role = guild.roles.cache.find(r => normalize(r.name) === normalize(result.rank));
    if (!role || role.managed || role.id === guild.id) return i.editReply(`Create this rank role first: ${result.rank}`);

    const botMember = await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
        botMember.roles.highest.comparePositionTo(role) <= 0) {
      return i.editReply("I need Manage Roles and a higher role position than the rank.");
    }
    if (member.id === guild.ownerId) return i.editReply("The server owner cannot be promoted.");
    const previous = member.roles.cache.filter(r => RANKS.some(n => normalize(n) === normalize(r.name)));

    try {
      if (previous.size) await member.roles.remove([...previous.values()], `Promotion by ${i.user.tag}`);
      await member.roles.add(role, `Promotion by ${i.user.tag}`);
    } catch (e) {
      console.error(e);
      return i.editReply("Promotion failed. Check Manage Roles and role hierarchy.");
    }

    const embed = new EmbedBuilder().setColor(0x202225).setTitle("Rank Promotion Log")
      .setDescription(
        `**Player:** ${user} (\`${user.id}\`)\n` +
        `**Previous Rank:** ${previous.map(r => r.name).join(", ") || "Unranked"}\n` +
        `**New Rank:** ${role.name}\n**Promoted By:** ${i.user}\n**Server:** ${guild.name}`
      ).setTimestamp();

    await sendLog(guild, "Rank Promotion Log",
      `**Player:** ${user} (\`${user.id}\`)\n**Previous Rank:** ${previous.map(r => r.name).join(", ") || "Unranked"}\n**New Rank:** ${role.name}\n**Promoted By:** ${i.user}`);
    await user.send(`You've been promoted to **${role.name}** in **${guild.name}**.`).catch(() => {});
    return i.editReply({ content: `Promoted ${user} to **${role.name}**.`, embeds: [embed] });
  }

  if (name === "rank") {
    if (i.guildId !== process.env.SOURCE_GUILD_ID) {
      return i.reply({ content: "Use this command in the configured source server.", ephemeral: true });
    }

    const user = i.options.getUser("user", true);
    const result = findRank(i.options.getString("role", true));
    if (result.error) return i.reply({ content: result.error, ephemeral: true });
    await i.deferReply({ ephemeral: true });

    const source = i.guild;
    const target = await client.guilds.fetch(process.env.TARGET_GUILD_ID).catch(() => null);
    if (!target) return i.editReply("I can't access the destination server.");
    if (source.id === target.id) return i.editReply("Source and destination servers must differ.");

    const channel = await source.channels.fetch(process.env.TRIAL_RESULTS_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased() || !channel.send) return i.editReply("I couldn't find the trial-results channel.");

    const member = await source.members.fetch(user.id).catch(() => null);
    if (!member) return i.editReply("That player isn't in the source server.");
    if (user.id === i.user.id || user.id === source.ownerId) return i.editReply("You can't rank-kick yourself or the server owner.");

    const role = target.roles.cache.find(r => normalize(r.name) === normalize(result.rank));
    if (!role || role.managed || role.id === target.id) return i.editReply(`Create this destination role first: ${result.rank}`);

    const sourceBot = source.members.me;
    const targetBot = await target.members.fetchMe();
    if (!sourceBot?.permissions.has(PermissionFlagsBits.KickMembers)) return i.editReply("I need Kick Members in the source server.");
    if (member.roles.highest.comparePositionTo(sourceBot.roles.highest) >= 0) return i.editReply("Move my highest role above the player in the source server.");
    if (!targetBot.permissions.has(PermissionFlagsBits.ManageRoles) ||
        targetBot.roles.highest.comparePositionTo(role) <= 0) {
      return i.editReply("I need Manage Roles and a higher role position in the destination server.");
    }

    state.pending[user.id] = { rankName: role.name, roleId: role.id, createdAt: Date.now() };
    saveState();

    const dm = new EmbedBuilder().setColor(0x202225).setTitle("Rank Update")
      .setDescription(`You've been ranked to **${role.name}**.\n\nJoin the ranking server to receive your role:\n${process.env.TARGET_INVITE_URL}`)
      .setTimestamp();
    let dmSent = true;
    try { await user.send({ embeds: [dm] }); } catch { dmSent = false; }

    const resultEmbed = new EmbedBuilder().setColor(0x202225).setTitle("Trial Results")
      .setDescription(`**Player:** ${user}\n**Decision:** Successfully ranked\n**New Rank:** ${role.name}\n**Issued By:** ${i.user}\n\n*Join the ranking server to receive your role.*`)
      .setTimestamp();

    try {
      await channel.send({ content: user.toString(), embeds: [resultEmbed], allowedMentions: { users: [user.id] } });
    } catch {
      delete state.pending[user.id];
      saveState();
      return i.editReply("Couldn't post the result. Nobody was kicked.");
    }

    try {
      await member.kick(`Ranked to ${role.name}.`);
    } catch {
      return i.editReply("Result posted, but kick failed. Check permissions and role hierarchy.");
    }

    return i.editReply(`Done. Result posted, DM ${dmSent ? "sent" : "blocked"}, and player kicked from the source server. Their rank will be assigned when they join the destination server.`);
  }
});

client.on(Events.GuildMemberAdd, async member => {
  const assignment = state.pending[member.id];
  if (member.guild.id === process.env.TARGET_GUILD_ID && assignment) {
    const role = member.guild.roles.cache.get(assignment.roleId) ||
      member.guild.roles.cache.find(r => normalize(r.name) === normalize(assignment.rankName));
    if (role && !role.managed && role.id !== member.guild.id) {
      const botMember = await member.guild.members.fetchMe();
      if (botMember.permissions.has(PermissionFlagsBits.ManageRoles) &&
          botMember.roles.highest.comparePositionTo(role) > 0) {
        try {
          await member.roles.add(role, "Pending rank from trial results");
          delete state.pending[member.id];
          saveState();
          await member.send(`Your rank has been applied: **${role.name}**.`).catch(() => {});
        } catch (e) {
          console.error("Pending rank assignment failed:", e.message);
        }
      }
    }
  }

  if (member.user.bot) {
    protectFromNuke(member.guild, AuditLogEvent.BotAdd, `Bot added: ${member.user.tag}`);
  }

  const cfg = setting(member.guild.id);
  if (!cfg.antiraid) return;
  const now = Date.now();
  const recent = (joinHits.get(member.guild.id) || []).filter(t => now - t < 15_000);
  recent.push(now);
  joinHits.set(member.guild.id, recent);
  if (recent.length === 8) {
    await sendLog(member.guild, "Anti-Raid: Join Burst",
      `**Alert:** 8 members joined within 15 seconds.\nReview the joins and use Discord's built-in Raid Protection if needed.`,
      0xE67E22);
  }
});

client.on(Events.ChannelDelete, channel => {
  if (channel.guild) protectFromNuke(channel.guild, AuditLogEvent.ChannelDelete, `Channel deleted: ${channel.name}`);
});
client.on(Events.RoleDelete, role => protectFromNuke(role.guild, AuditLogEvent.RoleDelete, `Role deleted: ${role.name}`));
client.on(Events.WebhooksUpdate, channel => protectFromNuke(channel.guild, AuditLogEvent.WebhookCreate, `Webhook update in #${channel.name}`));

async function start() {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.SOURCE_GUILD_ID),
    { body: commands.map(c => c.toJSON()) }
  );
  await client.login(process.env.DISCORD_TOKEN);
}
start().catch(error => {
  console.error("Bot startup failed:", error);
  process.exit(1);
});
'''
p.write_text(code, encoding="utf-8")
print(f"Created {p} ({p.stat().st_size:,} bytes)")
