module.exports = {
  apps: [
    {
      name: "bot",
      script: "server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        API_PORT: 5000
      }
    }
  ]
};
