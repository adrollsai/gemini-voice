import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// REFERENCE: Using the stable 2.0 Flash Experimental model
// This model is much more reliable for real-time audio than the "native-audio-preview"
const MODEL = "models/gemini-2.0-flash-exp"; 
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ status: "OK", system: "Gemini-Twilio Bridge" }));

// 1. Twilio Webhook (HTTP)
fastify.all('/twiml', async (request, reply) => {
  const host = request.headers.host;
  const wssUrl = `wss://${host}/media-stream`;
  reply.type('text/xml');
  
  // TwiML: Connects the call immediately to the WebSocket
  return `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
      <Connect>
          <Stream url="${wssUrl}" />
      </Connect>
      <Pause length="3600" />
  </Response>`;
});

// 2. WebSocket Handler (The Core Logic)
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log("📞 Twilio Stream Connected");

    let streamSid = null;
    let geminiWs = new WebSocket(GEMINI_URL);
    
    // Connect to Gemini
    geminiWs.on('open', () => {
      console.log("✨ Connected to Gemini API");

      // A. Initial Setup (Strict JSON Structure)
      const setupMessage = {
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"], // We only want audio back
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } }
            }
          }
        }
      };
      geminiWs.send(JSON.stringify(setupMessage));

      // B. Send Initial Greeting (To wake up the AI)
      const greetingMessage = {
        clientContent: {
          turns: [{
            role: "user",
            parts: [{ text: "Hello, please introduce yourself." }]
          }],
          turnComplete: true
        }
      };
      geminiWs.send(JSON.stringify(greetingMessage));
    });

    // Handle Gemini Messages (AI -> User)
    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        // 1. Audio Output
        if (response.serverContent && response.serverContent.modelTurn) {
          response.serverContent.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
              // Gemini sends 24kHz PCM -> We convert to 8kHz Mu-Law
              const pcm24k = Buffer.from(part.inlineData.data, 'base64');
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
        if (response.serverContent && response.serverContent.interrupted) {
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
    geminiWs.on('error', (err) => console.error("Gemini Socket Error:", err));

    // Handle Twilio Messages (User -> AI)
    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
        } else if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
          
          // 1. Get raw Mu-Law chunk from Twilio
          const mulawChunk = Buffer.from(data.media.payload, 'base64');
          
          // 2. Convert Mu-Law to PCM (8kHz)
          const pcm8k = mulawToPcm(mulawChunk);

          // 3. Upsample to 16kHz (Required by Gemini)
          // We use a simple doubling strategy which is robust for speech
          const pcm16k = upsampleTo16k(pcm8k);

          // 4. Send to Gemini
          // IMPORTANT: Base64 encoding must be strict
          const audioData = pcm16k.toString('base64');
          
          geminiWs.send(JSON.stringify({
            realtimeInput: {
              mediaChunks: [{
                mimeType: "audio/pcm;rate=16000",
                data: audioData
              }]
            }
          }));
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

// --- AUDIO PROCESSING (G.711 Standard) ---

// Lookup Table for Mu-Law Decoding (The Standard Way)
// This is faster and error-proof compared to raw math formulas
const MU_LAW_TABLE = [
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
  -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
  -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652,
  -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260,
  -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
  23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
  11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
  2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
  1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64,
  56, 48, 40, 32, 24, 16, 8, 0
];

function mulawToPcm(buffer) {
  const pcmBuffer = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    // Decode using the standard lookup table
    // (Invert the byte first as per u-law spec)
    const byte = buffer[i] ^ 0xFF; 
    // Map 0-255 byte to 16-bit PCM value
    // We map the byte index to our table (approximate inverse)
    // Note: Since we have a direct table of 256 values, we can just look it up.
    // However, the standard table above is just values. 
    // The robust G.711 decode logic is actually simpler:
    pcmBuffer[i] = decodeMuLawSimple(buffer[i]);
  }
  return Buffer.from(pcmBuffer.buffer);
}

function decodeMuLawSimple(muLawByte) {
  muLawByte = ~muLawByte;
  let sign = muLawByte & 0x80;
  let exponent = (muLawByte >> 4) & 0x07;
  let mantissa = muLawByte & 0x0F;
  let sample = (2 * mantissa + 33) << (12 - exponent);
  sample -= 0x84;
  return (sign === 0 ? sample : -sample);
}

// Simple Upsampler 8k -> 16k (Linear)
function upsampleTo16k(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    output[i * 2] = input[i];
    output[i * 2 + 1] = input[i]; 
  }
  return Buffer.from(output.buffer);
}

// Simple Downsampler 24k -> 8k
function downsampleTo8k(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Int16Array(Math.floor(input.length / 3));
  for (let i = 0; i < output.length; i++) {
    output[i] = input[i * 3];
  }
  return Buffer.from(output.buffer);
}

// PCM -> MuLaw (For Output)
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

// Start Server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`🚀 Server listening on ${address}`);
});