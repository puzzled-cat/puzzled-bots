// ===== FILE: index.js =====
import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import Database from 'better-sqlite3';

// --- Setup DB ---
const db = new Database('bot.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE(guild_id, user_id, name)
);
CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(list_id) REFERENCES lists(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  canceled INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER
);
`);

// --- Helpers ---
function parseDuration(str) {
  // Accepts things like: 10m, 2h, 3d, 1w, 45s
  if (!str) return null;
  const re = /^(\d+)\s*([smhdw])$/i;
  const m = str.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return n * mult;
}

function parseDateTime(str) {
  // Accept ISO-like: 2025-08-10 16:30 or 2025-08-10T16:30
  if (!str) return null;
  const normalized = str.replace(' ', 'T');
  const ts = Date.parse(normalized);
  return Number.isNaN(ts) ? null : ts;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Slash Commands ---
const commands = [
  new SlashCommandBuilder()
    .setName('list-create')
    .setDescription('Create a new list')
    .addStringOption(o => o.setName('name').setDescription('List name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('list-add')
    .setDescription('Add an item to a list')
    .addStringOption(o => o.setName('name').setDescription('List name').setRequired(true))
    .addStringOption(o => o.setName('item').setDescription('Item text').setRequired(true)),
  new SlashCommandBuilder()
    .setName('list-remove')
    .setDescription('Remove an item by index (as shown in /list-show)')
    .addStringOption(o => o.setName('name').setDescription('List name').setRequired(true))
    .addIntegerOption(o => o.setName('index').setDescription('1-based index').setRequired(true)),
  new SlashCommandBuilder()
    .setName('list-show')
    .setDescription('Show items in a list')
    .addStringOption(o => o.setName('name').setDescription('List name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('list-all')
    .setDescription('Show all lists you own in this server'),
  new SlashCommandBuilder()
    .setName('list-delete')
    .setDescription('Delete one of your lists')
    .addStringOption(o => o.setName('name').setDescription('List name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reminder-add')
    .setDescription('Create a reminder after a duration (e.g., 10m, 2h, 3d)')
    .addStringOption(o => o.setName('in').setDescription('Duration like 10m / 2h / 3d').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Reminder message').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reminder-at')
    .setDescription('Create a reminder at a specific date/time (e.g., 2025-08-10 16:30)')
    .addStringOption(o => o.setName('datetime').setDescription('YYYY-MM-DD HH:mm or ISO').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Reminder message').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reminder-list')
    .setDescription('List your pending reminders'),
  new SlashCommandBuilder()
    .setName('reminder-cancel')
    .setDescription('Cancel a reminder by ID')
    .addIntegerOption(o => o.setName('id').setDescription('Reminder ID').setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('✅ Guild commands registered.');
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✅ Global commands registered (may take up to an hour to appear).');
    }
  } catch (e) {
    console.error('Failed to register commands:', e);
  }
}

// --- List DB ops ---
const getOrCreateList = db.prepare(`INSERT OR IGNORE INTO lists (guild_id, user_id, name) VALUES (?, ?, ?);`);
const findList = db.prepare(`SELECT * FROM lists WHERE guild_id=? AND user_id=? AND name=?;`);
const listLists = db.prepare(`SELECT name FROM lists WHERE guild_id=? AND user_id=? ORDER BY name;`);
const deleteList = db.prepare(`DELETE FROM lists WHERE guild_id=? AND user_id=? AND name=?;`);
const addItem = db.prepare(`INSERT INTO list_items (list_id, content, created_at) VALUES (?, ?, ?);`);
const getItems = db.prepare(`SELECT id, content FROM list_items WHERE list_id=? ORDER BY id;`);
const removeItemByIndex = (listId, index) => {
  const items = getItems.all(listId);
  const idx = index - 1;
  if (idx < 0 || idx >= items.length) return false;
  const itemId = items[idx].id;
  db.prepare('DELETE FROM list_items WHERE id=?').run(itemId);
  return true;
};

// --- Reminder DB ops ---
const insertReminder = db.prepare(`INSERT INTO reminders (guild_id, channel_id, user_id, message, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?);`);
const selectPendingDue = db.prepare(`SELECT * FROM reminders WHERE canceled=0 AND sent_at IS NULL AND due_at <= ? ORDER BY due_at ASC LIMIT 50;`);
const markSent = db.prepare(`UPDATE reminders SET sent_at=? WHERE id=?;`);
const listUserReminders = db.prepare(`SELECT id, message, due_at FROM reminders WHERE canceled=0 AND sent_at IS NULL AND guild_id=? AND user_id=? ORDER BY due_at;`);
const cancelReminder = db.prepare(`UPDATE reminders SET canceled=1 WHERE id=? AND canceled=0;`);

// --- Scheduler loop (every 30s) ---
async function schedulerTick() {
  const now = Date.now();
  const due = selectPendingDue.all(now);
  for (const r of due) {
    try {
      const channel = await client.channels.fetch(r.channel_id);
      await channel.send({ content: `<@${r.user_id}> ⏰ Reminder: ${r.message}` });
      markSent.run(Date.now(), r.id);
    } catch (e) {
      console.error('Failed to deliver reminder', r.id, e);
    }
  }
}

// --- Interaction handling ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  const gid = interaction.guildId;
  const uid = interaction.user.id;

  try {
    if (commandName === 'list-create') {
      const name = interaction.options.getString('name', true).trim();
      getOrCreateList.run(gid, uid, name);
      return interaction.reply({ ephemeral: true, content: `📋 List **${name}** ready.` });
    }
    if (commandName === 'list-add') {
      const name = interaction.options.getString('name', true).trim();
      const item = interaction.options.getString('item', true).trim();
      const list = findList.get(gid, uid, name);
      if (!list) return interaction.reply({ ephemeral: true, content: `No list called **${name}**. Use /list-create first.` });
      addItem.run(list.id, item, Date.now());
      return interaction.reply({ ephemeral: true, content: `➕ Added to **${name}**: ${item}` });
    }
    if (commandName === 'list-remove') {
      const name = interaction.options.getString('name', true).trim();
      const index = interaction.options.getInteger('index', true);
      const list = findList.get(gid, uid, name);
      if (!list) return interaction.reply({ ephemeral: true, content: `No list called **${name}**.` });
      const ok = removeItemByIndex(list.id, index);
      return interaction.reply({ ephemeral: true, content: ok ? `🗑️ Removed item #${index} from **${name}**.` : `Index out of range.` });
    }
    if (commandName === 'list-show') {
      const name = interaction.options.getString('name', true).trim();
      const list = findList.get(gid, uid, name);
      if (!list) return interaction.reply({ ephemeral: true, content: `No list called **${name}**.` });
      const items = getItems.all(list.id);
      const body = items.length ? items.map((it, i) => `${i + 1}. ${it.content}`).join('\n') : '*empty*';
      return interaction.reply({ ephemeral: true, content: `**${name}**\n${body}` });
    }
    if (commandName === 'list-all') {
      const rows = listLists.all(gid, uid);
      const names = rows.map(r => `• ${r.name}`).join('\n') || '*no lists yet*';
      return interaction.reply({ ephemeral: true, content: `Your lists here:\n${names}` });
    }
    if (commandName === 'list-delete') {
      const name = interaction.options.getString('name', true).trim();
      const info = deleteList.run(gid, uid, name);
      return interaction.reply({ ephemeral: true, content: info.changes ? `🗑️ Deleted **${name}**.` : `No list called **${name}**.` });
    }
    if (commandName === 'reminder-add') {
      const durStr = interaction.options.getString('in', true).trim();
      const msg = interaction.options.getString('message', true).trim();
      const ms = parseDuration(durStr);
      if (!ms) return interaction.reply({ ephemeral: true, content: 'Use a duration like 10m, 2h, 3d, 45s.' });
      const due = Date.now() + ms;
      const info = insertReminder.run(gid, interaction.channelId, uid, msg, due, Date.now());
      return interaction.reply({ ephemeral: true, content: `⏰ Reminder #${info.lastInsertRowid} set for <t:${Math.floor(due/1000)}:f> — "${msg}"` });
    }
    if (commandName === 'reminder-at') {
      const dt = interaction.options.getString('datetime', true).trim();
      const msg = interaction.options.getString('message', true).trim();
      const ts = parseDateTime(dt);
      if (!ts) return interaction.reply({ ephemeral: true, content: 'Use format YYYY-MM-DD HH:mm (24h) or ISO like 2025-08-10T16:30.' });
      if (ts < Date.now() - 30_000) return interaction.reply({ ephemeral: true, content: 'That time is in the past.' });
      const info = insertReminder.run(gid, interaction.channelId, uid, msg, ts, Date.now());
      return interaction.reply({ ephemeral: true, content: `⏰ Reminder #${info.lastInsertRowid} set for <t:${Math.floor(ts/1000)}:f> — "${msg}"` });
    }
    if (commandName === 'reminder-list') {
      const rows = listUserReminders.all(gid, uid);
      const text = rows.length ? rows.map(r => `#${r.id} — <t:${Math.floor(r.due_at/1000)}:f> — ${r.message}`).join('\n') : '*no pending reminders*';
      return interaction.reply({ ephemeral: true, content: text });
    }
    if (commandName === 'reminder-cancel') {
      const id = interaction.options.getInteger('id', true);
      const info = cancelReminder.run(id);
      return interaction.reply({ ephemeral: true, content: info.changes ? `🚫 Canceled reminder #${id}.` : `Could not find an active reminder #${id}.` });
    }
  } catch (err) {
    console.error(err);
    return interaction.reply({ ephemeral: true, content: 'Something went wrong. Try again.' });
  }
});

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  setInterval(schedulerTick, 30_000);
});

await registerCommands();
await client.login(process.env.DISCORD_TOKEN);
