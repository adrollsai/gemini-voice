import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ⚠️ REQUIRED MODEL
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";

const GEMINI_URL =
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---------- ROUTES ----------
fastify.get('/', async () => ({
  status: "OK",
  system: "Gemini 2.5 Native Audio Voice Bridge"
}));

fastify.all('/twiml', async (request, reply) => {
  const host = request.headers.host;
  const wssUrl = `wss://${host}/media-stream`;

  reply.type('text/xml');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wssUrl}" />
  </Connect>
  <Pause length="3600" />
</Response>`;
});

// ---------- MEDIA STREAM ----------
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection) => {
    console.log("🔵 [Twilio] Connected");

    let streamSid = null;
    let geminiReady = false;
    let packetCount = 0;

    const geminiWs = new WebSocket(GEMINI_URL);

    // ---------- GEMINI ----------
    geminiWs.on('open', () => {
      console.log("🟢 [Gemini] Connected");

      // ✅ NO speech_config for 2.5
      geminiWs.send(JSON.stringify({
        setup: {
          model: MODEL
        }
      }));
    });

    geminiWs.on('message', (data) => {
      const response = JSON.parse(data);

      // ---- SETUP COMPLETE ----
      if (response.setupComplete && !geminiReady) {
        geminiReady = true;
        console.log("✅ [Gemini] Setup Complete");

        // Initial greeting
        geminiWs.send(JSON.stringify({
          client_content: {
            turns: [{
              role: "user",
              parts: [{ text: "Hello, please introduce yourself briefly." }]
            }],
            turn_complete: true
          }
        }));
      }

      // ---- AUDIO OUTPUT ----
      if (response.serverContent?.modelTurn?.parts && streamSid) {
        response.serverContent.modelTurn.parts.forEach(part => {
          if (
            part.inlineData?.mimeType?.startsWith("audio/pcm")
          ) {
            // Gemini 2.5 outputs 16-bit PCM @ 24kHz
            const pcm24kBuf = Buffer.from(part.inlineData.data, 'base64');
            const pcm24kInt16 = new Int16Array(
              pcm24kBuf.buffer,
              pcm24kBuf.byteOffset,
              pcm24kBuf.length / 2
            );

            const mulaw8k = convertPcm24kToMulaw8k(
              Buffer.from(pcm24kInt16.buffer)
            );

            connection.socket.send(JSON.stringify({
              event: "media",
              streamSid,
              media: {
                payload: mulaw8k.toString('base64')
              }
            }));
          }
        });
      }
    });

    geminiWs.on('close', () =>
      console.log("🔴 [Gemini] Closed")
    );

    geminiWs.on('error', (err) =>
      console.error("Gemini Error:", err)
    );

    // ---------- TWILIO ----------
    connection.socket.on('message', (msg) => {
      const data = JSON.parse(msg);

      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log(`▶️ Stream Started: ${streamSid}`);
      }

      if (data.event === 'media' && geminiReady) {
        packetCount++;
        if (packetCount % 20 === 0) {
          console.log(`🎤 [Twilio] ${packetCount} packets`);
        }

        const mulaw = Buffer.from(data.media.payload, 'base64');
        const pcm16k = convertMulaw8kToPcm16k(mulaw);

        geminiWs.send(JSON.stringify({
          realtime_input: {
            media_chunks: [{
              mime_type: "audio/pcm;rate=16000",
              data: pcm16k.toString('base64')
            }]
          }
        }));
      }

      if (data.event === 'stop') {
        console.log("⏹️ Stream stopped");

        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({
            realtime_input: { turn_complete: true }
          }));
        }

        geminiWs.close();
      }
    });
  });
});

// ---------- AUDIO UTILS ----------

const MU_LAW_TABLE = [ /* unchanged full table */ ];

function convertMulaw8kToPcm16k(mulawBuffer) {
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = MU_LAW_TABLE[mulawBuffer[i] ^ 0xff];
  }

  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    pcm16k[i * 2] = pcm8k[i];
    pcm16k[i * 2 + 1] = pcm8k[i];
  }

  return Buffer.from(pcm16k.buffer);
}

function convertPcm24kToMulaw8k(pcmBuffer) {
  const pcm = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.length / 2
  );

  const mulaw = new Uint8Array(Math.floor(pcm.length / 3));
  for (let i = 0; i < mulaw.length; i++) {
    mulaw[i] = encodeMuLaw(pcm[i * 3]);
  }
  return Buffer.from(mulaw);
}

const BIAS = 0x84;
const CLIP = 32635;

function encodeMuLaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa);
}

// ---------- START ----------
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server listening on ${address}`);
});
