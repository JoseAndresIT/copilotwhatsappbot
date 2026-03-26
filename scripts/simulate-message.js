require('dotenv').config();

const { handleIncomingMessage, generateReply } = require('../index');

async function run() {
  const inputText = process.argv.slice(2).join(' ').trim() || 'Hola, ¿me escuchas?';

  console.log('[SIMULATOR] Sending test prompt:', inputText);

  // Direct Ollama call test
  const directReply = await generateReply(inputText);
  console.log('[SIMULATOR] Direct generateReply() output:', directReply);

  // Simulated WhatsApp message test
  const fakeClient = {
    sendText: async (to, text) => {
      console.log(`[SIMULATOR][sendText] to=${to}`);
      console.log(`[SIMULATOR][sendText] text=${text}`);
      return true;
    },
  };

  const fakeMessage = {
    from: '1234567890@c.us',
    fromMe: false,
    isGroupMsg: false,
    body: inputText,
  };

  await handleIncomingMessage(fakeClient, fakeMessage);
  console.log('[SIMULATOR] Done.');
}

run().catch((error) => {
  console.error('[SIMULATOR][ERROR]', error && error.message ? error.message : error);
  process.exit(1);
});
