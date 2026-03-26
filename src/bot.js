require('dotenv').config();

const http = require('http');
const https = require('https');
const wa = require('@open-wa/wa-automate');
const axios = require('axios');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are a friendly assistant that speaks casually and naturally, like a close friend.';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 15000);

const ollamaHttpClient = axios.create({
  timeout: OLLAMA_TIMEOUT_MS,
  proxy: false,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  httpAgent: new http.Agent({
    keepAlive: true,
    family: 4,
  }),
  httpsAgent: new https.Agent({
    keepAlive: true,
  }),
});

function getChromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const platform = process.platform;

  if (platform === 'linux') return '/usr/bin/google-chrome';
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  return undefined;
}

function buildPrompt(userText) {
  return `${SYSTEM_PROMPT}\n\nUser: ${userText}\nAssistant:`;
}

async function generateReply(userText) {
  const prompt = buildPrompt(userText);
  const payload = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
  };

  const startedAt = Date.now();
  console.log('[OLLAMA][REQUEST] URL:', OLLAMA_URL);
  console.log('[OLLAMA][REQUEST] Timeout(ms):', OLLAMA_TIMEOUT_MS);
  console.log('[OLLAMA][REQUEST] Payload:', JSON.stringify(payload));

  try {
    const { data, status, headers } = await ollamaHttpClient.post(OLLAMA_URL, payload);
    const elapsedMs = Date.now() - startedAt;

    console.log('[OLLAMA][RESPONSE] Status:', status);
    console.log('[OLLAMA][RESPONSE] Headers:', JSON.stringify(headers || {}));
    console.log('[OLLAMA][RESPONSE] Body:', JSON.stringify(data || {}));
    console.log('[OLLAMA][RESPONSE] Elapsed(ms):', elapsedMs);

    const reply = (data && typeof data.response === 'string' ? data.response : '').trim();
    return reply || 'Sorry, I could not generate a reply right now.';
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const code = error && error.code ? error.code : 'UNKNOWN';
    const status = error && error.response ? error.response.status : 'NO_STATUS';
    const responseData = error && error.response ? error.response.data : null;

    console.error('[OLLAMA][ERROR] Code:', code);
    console.error('[OLLAMA][ERROR] Status:', status);
    console.error('[OLLAMA][ERROR] Elapsed(ms):', elapsedMs);
    console.error('[OLLAMA][ERROR] Message:', error && error.message ? error.message : error);
    console.error('[OLLAMA][ERROR] Response body:', JSON.stringify(responseData));

    throw error;
  }
}

async function handleIncomingMessage(client, message) {
  try {
    if (!message || message.isGroupMsg || message.fromMe) return;

    const incomingText = (message.body || '').trim();
    if (!incomingText) return;

    console.log(`[INCOMING] ${message.from}: ${incomingText}`);

    const aiResponse = await generateReply(incomingText);
    await client.sendText(message.from, aiResponse);

    console.log(`[REPLIED] ${message.from}: ${aiResponse}`);
  } catch (error) {
    console.error('[ERROR] Failed to process message:', error && error.message ? error.message : error);

    if (message && message.from) {
      await client
        .sendText(
          message.from,
          'Oops, I hit a small issue while thinking. Please try again in a moment 🙏'
        )
        .catch(() => {});
    }
  }
}

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
  console.log(`⏱️ Ollama timeout(ms): ${OLLAMA_TIMEOUT_MS}`);

  client.onMessage((message) => {
    handleIncomingMessage(client, message);
  });
}

module.exports = {
  buildPrompt,
  generateReply,
  getChromeExecutablePath,
  handleIncomingMessage,
  startBot,
};
