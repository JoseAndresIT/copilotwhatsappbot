# Ollama WhatsApp Bot (Node.js + open-wa)

Bot de WhatsApp en Node.js que envía mensajes entrantes a Ollama local y devuelve respuestas conversacionales.

## Requisitos

- Node.js 25.8.1 (o compatible)
- npm 11.11.0 (o compatible)
- Linux/macOS/Windows
- Google Chrome instalado (si no, define `CHROME_PATH`)
- Ollama corriendo localmente (`ollama serve`)
- Modelo descargado en Ollama (ejemplo: `ollama pull mistral`)

## Instalación

```bash
npm install
cp .env.example .env
```

## Variables de entorno (`.env`)

```env
OLLAMA_URL=http://127.0.0.1:11434/api/generate
OLLAMA_MODEL=mistral
SYSTEM_PROMPT=You are a friendly assistant that speaks casually and naturally, like a close friend.
WA_SESSION_ID=ollama-whatsapp-bot
OLLAMA_TIMEOUT_MS=15000
# CHROME_PATH=/usr/bin/google-chrome
```

## Probar Ollama desde terminal

```bash
curl -X POST http://127.0.0.1:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"mistral","prompt":"Hola, ¿me escuchas?","stream":false}'
```

## Estructura

- `index.js`: punto de entrada mínimo (ideal para reducir conflictos de merge).
- `src/bot.js`: lógica principal del bot (Ollama + WhatsApp).
- `scripts/simulate-message.js`: simulación local sin WhatsApp real.

## Ejecutar bot de WhatsApp

```bash
npm start
```

Al iniciar, escanea el QR y espera mensajes.

## Simular mensaje sin WhatsApp real

Prueba directa de `generateReply()` y del flujo de `handleIncomingMessage` sin abrir WhatsApp:

```bash
npm run simulate -- "Hola bot, ¿cómo estás?"
```

## Logging incluido

El bot imprime:
- Prompt enviado a Ollama
- URL, timeout y payload del request
- Status, headers y body de respuesta
- Tiempo total de ida y vuelta
- Errores detallados (code/status/body)

## Nota de timeout

Para pruebas, el timeout de Axios está en **15s** por defecto (`OLLAMA_TIMEOUT_MS=15000`).
Si tu modelo demora más, puedes subirlo en `.env`.
