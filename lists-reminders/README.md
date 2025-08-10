# Discord List & Reminder Bot

A Discord bot for managing personal lists and reminders using slash commands.

## Features
- Create, add to, remove from, and display personal lists.
- Set reminders for specific durations or exact date/times.
- SQLite database for persistent storage.
- Slash command interface.

## Commands
### Lists
- `/list-create name` — Create a new list.
- `/list-add name item` — Add an item to a list.
- `/list-remove name index` — Remove an item by its number from a list.
- `/list-show name` — Show all items in a list.
- `/list-all` — Show all lists you own in the server.
- `/list-delete name` — Delete one of your lists.

### Reminders
- `/reminder-add in message` — Set a reminder after a duration (e.g., `10m`, `2h`, `3d`).
- `/reminder-at datetime message` — Set a reminder at a specific date/time (e.g., `2025-08-10 16:30`).
- `/reminder-list` — List all your pending reminders.
- `/reminder-cancel id` — Cancel a reminder by its ID.

## Setup
1. Create a Discord bot in the Developer Portal and note your **TOKEN**, **CLIENT ID**, and optionally your **GUILD ID**.
2. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file:
   ```env
   DISCORD_TOKEN=your-bot-token
   CLIENT_ID=your-client-id
   GUILD_ID=your-guild-id # optional
   ```
4. Start the bot:
   ```bash
   npm start
   ```

## License
MIT
