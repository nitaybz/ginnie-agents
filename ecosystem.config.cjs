// PM2 ecosystem config for ginnie-agents
// Start: pm2 start ecosystem.config.cjs
// Logs:  pm2 logs ginnie-agents-listener
//
// CLAUDE_CODE_OAUTH_TOKEN must be set in the shell that starts/restarts PM2
// (we read it via process.env so it's not committed to git). Generate with
// `claude setup-token` (~1 year). After updating it in ~/.zshrc, restart with:
//   pm2 restart ecosystem.config.cjs --update-env

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
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
      },
    },
  ],
};
