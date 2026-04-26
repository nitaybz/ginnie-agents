// PM2 ecosystem config for ginnie-agents
// Start: pm2 start ecosystem.config.cjs
// Logs:  pm2 logs ginnie-agents-listener
//
// Environment is loaded from .env at the repo root by the listener itself
// (via dotenv with override=true). You do NOT need to export anything in
// your shell rc — put CLAUDE_CODE_OAUTH_TOKEN, TZ, and any other config
// in .env and that's it.

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
  ],
};
