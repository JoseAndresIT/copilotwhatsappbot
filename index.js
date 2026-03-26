require('dotenv').config();

const wa = require('@open-wa/wa-automate');
const axios = require('axios');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are a friendly assistant that speaks casually and naturally, like a close friend.';

/**
 * Returns a platform-aware Chrome executable path.
 * Priority: CHROME_PATH env var -> known OS defaults.
 */
function getChromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const platform = process.platform;

  if (platform === 'linux') {
    return '/usr/bin/google-chrome';
  }

  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  if (platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }

  return undefined;
}

/**
 * Sends a prompt to the local Ollama server and returns the model response text.
 */
async function generateReply(userText) {
  const prompt = `${SYSTEM_PROMPT}\n\nUser: ${userText}\nAssistant:`;

  const { data } = await axios.post(
    OLLAMA_URL,
    {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
    },
    {
      timeout: 120000,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );

  return (data?.response || 'Sorry, I could not generate a reply right now.').trim();
}

/**
 * Main WhatsApp message handler.
 */
async function handleIncomingMessage(client, message) {
  try {
    if (!message || message.isGroupMsg || message.fromMe) return;

    const incomingText = (message.body || '').trim();

    // Ignore empty/non-text messages
    if (!incomingText) return;

    console.log(`[INCOMING] ${message.from}: ${incomingText}`);

    const aiResponse = await generateReply(incomingText);

    await client.sendText(message.from, aiResponse);

    console.log(`[REPLIED] ${message.from}: ${aiResponse}`);
  } catch (error) {
    console.error('[ERROR] Failed to process message:', error?.message || error);

    // Optional fallback response so user knows the bot is alive.
    if (message?.from) {
      await client
        .sendText(
          message.from,
          'Oops, I hit a small issue while thinking. Please try again in a moment 🙏'
        )
        .catch(() => {});
    }
  }
}

/**
 * Bootstraps the WhatsApp client.
 */
async function startBot() {
  const executablePath = getChromeExecutablePath();

  const client = await wa.create({
    sessionId: process.env.WA_SESSION_ID || 'ollama-whatsapp-bot',
    multiDevice: true,
    qrTimeout: 0,
    authTimeout: 0,
    headless: true,
    useChrome: true,
    executablePath,
    killProcessOnBrowserClose: true,
    disableSpins: true,
    logConsole: false,
  });

  console.log('✅ WhatsApp bot is online and listening for messages...');
  console.log(`🤖 Ollama model: ${OLLAMA_MODEL}`);
  console.log(`🔗 Ollama endpoint: ${OLLAMA_URL}`);

  client.onMessage((message) => {
    handleIncomingMessage(client, message);
  });
}

startBot().catch((error) => {
  console.error('❌ Failed to start bot:', error?.message || error);
  process.exit(1);
});
