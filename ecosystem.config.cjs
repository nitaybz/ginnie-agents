// PM2 ecosystem config for ginnie-agents
// Start:   pm2 start ecosystem.config.cjs
// Logs:    pm2 logs ginnie-agents-listener
//          pm2 logs ginnie-agents-watcher
//
// Environment is loaded from .env at the repo root by each process itself
// (via dotenv with override=true). You do NOT need to export anything in
// your shell rc — put CLAUDE_CODE_OAUTH_TOKEN, TZ, WATCHER_BOT_TOKEN,
// WATCHER_APP_TOKEN, OPERATOR_SLACK_ID, etc. in .env and that's it.
//
// The Watcher is optional. If WATCHER_BOT_TOKEN / WATCHER_APP_TOKEN /
// OPERATOR_SLACK_ID are not set in .env, the watcher process will exit
// immediately with a clear message (PM2 will not crash-loop because
// autorestart is conditional).

module.exports = {
  apps: [
    {
      name: "ginnie-agents-listener",
      script: "dist/index.js",
      cwd: "./listener",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "ginnie-agents-watcher",
      script: "dist/watcher.js",
      cwd: "./listener",
      watch: false,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
