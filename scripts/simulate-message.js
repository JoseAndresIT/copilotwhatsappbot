require('dotenv').config();

const { handleIncomingMessage, generateReply } = require('../src/bot');

function getMessagesFromCli() {
  const rawArgs = process.argv.slice(2);
  if (!rawArgs.length) return ['Hola, ¿me escuchas?'];

  return rawArgs
    .flatMap((arg) => arg.split('||'))
    .map((msg) => msg.trim())
    .filter(Boolean);
}

function warnMissingEnv() {
  ['OLLAMA_URL', 'OLLAMA_MODEL', 'SYSTEM_PROMPT'].forEach((key) => {
    if (!process.env[key]) {
      console.warn(`[SIMULATOR][WARN] ${key} no está definido. Se usará valor por defecto.`);
    }
  });
}

async function runSingleMessage(inputText, idx, total) {
  console.log('\n==================================================');
  console.log(`[SIMULATOR] Test ${idx + 1}/${total}`);
  console.log(`[SIMULATOR] Input: ${inputText}`);
  console.log('==================================================');

  const startedAt = Date.now();

  const directReply = await generateReply(inputText);
  console.log('[SIMULATOR] Direct generateReply() output:', directReply);

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

  const elapsedMs = Date.now() - startedAt;
  console.log(`[SIMULATOR] Execution time: ${elapsedMs} ms`);
}

async function run() {
  warnMissingEnv();

  const messages = getMessagesFromCli();

  for (let idx = 0; idx < messages.length; idx += 1) {
    await runSingleMessage(messages[idx], idx, messages.length);
  }

  console.log('\n[SIMULATOR] Done.');
}

run().catch((error) => {
  console.error('[SIMULATOR][ERROR]', error && error.message ? error.message : error);
  process.exit(1);
});
