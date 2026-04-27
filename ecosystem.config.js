module.exports = {
  apps: [
    {
      name: "bot",
      script: "server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        API_PORT: 5000
      },
      autorestart: true,
      max_restarts: 20,
      min_uptime: "30s",
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "512M",
      time: true,
      out_file: "./logs/bot-out.log",
      error_file: "./logs/bot-err.log",
      merge_logs: true
    }
  ]
};
