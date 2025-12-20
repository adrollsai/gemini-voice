import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Use the 2.0 Flash Exp model (Verified for reliable audio streaming)
const MODEL = "models/gemini-2.0-flash-exp"; 
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ status: "OK", system: "Gemini 2.0 Flash Voice Bridge" }));

// 1. Twilio Webhook
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

// 2. WebSocket Handler
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log("📞 Twilio Connected");

    let streamSid = null;
    let geminiWs = new WebSocket(GEMINI_URL);
    let isSessionActive = false; // Flag to track if Setup is complete

    // Connect to Gemini
    geminiWs.on('open', () => {
      console.log("✨ Connected to Gemini");

      // A. Send Setup Message
      const setupMsg = {
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: { prebuilt_voice_config: { voice_name: "Puck" } }
            }
          }
        }
      };
      geminiWs.send(JSON.stringify(setupMsg));
    });

    // Handle Gemini Messages
    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        // A. Handle Setup Completion (CRITICAL STEP)
        // We must wait for this before sending any audio or greetings
        if (response.setupComplete) {
          console.log("✅ Gemini Session Ready");
          isSessionActive = true;

          // Send Initial Greeting
          const greetingMsg = {
            client_content: {
              turns: [{
                role: "user",
                parts: [{ text: "Hello, please introduce yourself." }]
              }],
              turn_complete: true
            }
          };
          geminiWs.send(JSON.stringify(greetingMsg));
        }

        // B. Audio Output (Gemini -> Twilio)
        if (response.serverContent?.modelTurn?.parts) {
          response.serverContent.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
              // Convert 24k PCM -> 8k Mu-Law
              const pcm24k = Buffer.from(part.inlineData.data, 'base64');
              const mulaw8k = convertPcm24kToMulaw8k(pcm24k);
              
              if (streamSid) {
                connection.socket.send(JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: mulaw8k.toString('base64') }
                }));
              }
            }
          });
        }

        // C. Interruption Handling
        if (response.serverContent?.interrupted) {
          console.log("🛑 Gemini Interrupted");
          if (streamSid) connection.socket.send(JSON.stringify({ event: "clear", streamSid }));
        }
      } catch (e) {
        console.error("Gemini Parse Error:", e);
      }
    });

    geminiWs.on('close', (code, reason) => console.log(`Gemini Closed: ${code} ${reason}`));
    geminiWs.on('error', (err) => console.error("Gemini Error:", err));

    // Handle Twilio Messages
    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
        } else if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
          
          // CRITICAL: Only send audio if session is ready
          if (!isSessionActive) return;

          // 1. Get Audio Chunk (Mu-Law)
          const mulawChunk = Buffer.from(data.media.payload, 'base64');
          
          // 2. Convert to PCM 16kHz (Manual Linear Interpolation)
          const pcm16k = convertMulaw8kToPcm16k(mulawChunk);

          // 3. Send to Gemini
          const audioMsg = {
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: pcm16k.toString('base64')
              }]
            }
          };
          geminiWs.send(JSON.stringify(audioMsg));
        
        } else if (data.event === 'stop') {
          geminiWs.close();
        }
      } catch (e) {
        console.error("Twilio Error:", e);
      }
    });
  });
});

// --- AUDIO CONVERSION UTILS (No External Deps) ---

// 1. Mu-Law to 16kHz PCM (Linear Interpolation)
function convertMulaw8kToPcm16k(mulawBuffer) {
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = decodeMuLaw(mulawBuffer[i]);
  }
  
  // Upsample 8k -> 16k (Smooth Fill)
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    const current = pcm8k[i];
    const next = (i < pcm8k.length - 1) ? pcm8k[i + 1] : current;
    pcm16k[i * 2] = current;
    pcm16k[i * 2 + 1] = Math.round((current + next) / 2);
  }
  
  return Buffer.from(pcm16k.buffer);
}

// 2. 24kHz PCM to Mu-Law (Simple Decimation)
function convertPcm24kToMulaw8k(pcmBuffer) {
  const pcm24k = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  const mulaw = new Uint8Array(Math.floor(pcm24k.length / 3));
  
  for (let i = 0; i < mulaw.length; i++) {
    // Downsample: Take every 3rd sample
    mulaw[i] = encodeMuLaw(pcm24k[i * 3]);
  }
  return Buffer.from(mulaw);
}

// G.711 Mu-Law Lookup Tables
const BIAS = 0x84;
const CLIP = 32635;

function encodeMuLaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) { }
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let byte = ~(sign | (exponent << 4) | mantissa);
  return byte;
}

function decodeMuLaw(muLawByte) {
  muLawByte = ~muLawByte;
  let sign = muLawByte & 0x80;
  let exponent = (muLawByte >> 4) & 0x07;
  let mantissa = muLawByte & 0x0F;
  let sample = (2 * mantissa + 33) << (12 - exponent);
  sample -= BIAS;
  return (sign === 0 ? sample : -sample);
}

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`🚀 Server listening on ${address}`);
});