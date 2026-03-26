const { startBot } = require('./src/bot');

if (require.main === module) {
  startBot().catch((error) => {
    console.error('❌ Failed to start bot:', error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = require('./src/bot');
