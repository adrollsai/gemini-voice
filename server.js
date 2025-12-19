import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

// Configuration
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "models/gemini-2.0-flash-exp"; 
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ status: "OK", system: "Gemini-Twilio Bridge" }));

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
    console.log("📞 Twilio Stream Connected");

    let streamSid = null;
    let geminiWs = new WebSocket(GEMINI_URL);

    // Connect to Gemini
    geminiWs.on('open', () => {
      console.log("✨ Connected to Gemini API");

      // A. Initial Setup
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

      // B. Initial Greeting
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
    });

    // Handle Gemini Messages (AI -> User)
    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        // 1. Audio Output
        if (response.server_content && response.server_content.model_turn) {
          response.server_content.model_turn.parts.forEach(part => {
            if (part.inline_data && part.inline_data.mime_type.startsWith('audio/pcm')) {
              // Gemini 24k -> Twilio 8k Mu-Law
              const pcm24k = Buffer.from(part.inline_data.data, 'base64');
              const pcm8k = downsampleTo8k(pcm24k);
              const mulaw8k = pcmToMulaw(pcm8k);
              
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

        // 2. Interruption Handling
        if (response.server_content && response.server_content.interrupted) {
          console.log("🛑 Gemini Interrupted");
          if (streamSid) {
            connection.socket.send(JSON.stringify({ event: "clear", streamSid }));
          }
        }
      } catch (e) {
        console.error("Gemini Error:", e);
      }
    });

    geminiWs.on('close', () => console.log("Gemini Disconnected"));

    // Handle Twilio Messages (User -> AI)
    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
        } else if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
          
          // 1. Decode Twilio Audio (Mu-Law -> PCM 8k)
          const mulawChunk = Buffer.from(data.media.payload, 'base64');
          const pcm8k = mulawToPcm(mulawChunk);

          // 2. Upsample to 16k using LINEAR INTERPOLATION
          // This is the critical fix for voice recognition quality
          const pcm16k = upsampleLinear(pcm8k, 8000, 16000);
          const base64Audio = pcm16k.toString('base64');

          // 3. Send to Gemini
          const audioMsg = {
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm;rate=16000",
                data: base64Audio
              }]
            }
          };
          geminiWs.send(JSON.stringify(audioMsg));
        
        } else if (data.event === 'stop') {
          console.log("⏹️ Call Stopped");
          geminiWs.close();
        }
      } catch (e) {
        console.error("Twilio Error:", e);
      }
    });
  });
});

// --- AUDIO UTILS (The Magic Sauce) ---

/**
 * Linear Interpolation Resampler (8k -> 16k)
 * Mimics high-quality resampling by averaging samples.
 * @param {Int16Array} input - 8kHz PCM
 * @param {number} fromRate - 8000
 * @param {number} toRate - 16000
 */
function upsampleLinear(inputBuffer, fromRate, toRate) {
  const input = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 2);
  const output = new Int16Array(input.length * 2); // strictly for 2x upsampling

  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    const next = (i < input.length - 1) ? input[i+1] : current;
    
    // Sample 1: The original point
    output[i * 2] = current;
    
    // Sample 2: The interpolated point (average)
    // This creates a smooth line between samples instead of a jagged step
    output[i * 2 + 1] = Math.round((current + next) / 2); 
  }
  return Buffer.from(output.buffer);
}

// Simple Decimation (24k -> 8k) is fine for downsampling speech
function downsampleTo8k(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Int16Array(Math.floor(input.length / 3));
  for (let i = 0; i < output.length; i++) {
    output[i] = input[i * 3];
  }
  return Buffer.from(output.buffer);
}

// G.711 Mu-Law Decoding Logic
function mulawToPcm(buffer) {
  const pcmBuffer = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    pcmBuffer[i] = decodeMuLaw(buffer[i]);
  }
  return Buffer.from(pcmBuffer.buffer);
}

const BIAS = 0x84;
const CLIP = 32635;

function pcmToMulaw(buffer) {
  const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const mulaw = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) mulaw[i] = encodeMuLaw(pcm[i]);
  return Buffer.from(mulaw);
}

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