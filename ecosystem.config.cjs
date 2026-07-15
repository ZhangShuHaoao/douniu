module.exports = {
  apps: [
    {
      name: 'douniu',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
