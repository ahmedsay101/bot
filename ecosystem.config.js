module.exports = {
  apps: [
    {
      name: "bot-api",
      script: "server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        API_PORT: 5000
      }
    },
    {
      name: "bot-dashboard",
      script: "node_modules/.bin/vite",
      args: "preview --port 3000 --host",
      cwd: __dirname + "/dashboard",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
