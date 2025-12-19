import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

// Configuration
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ status: "OK", message: "Gemini Voice Server Ready" }));

// 1. TwiML Webhook
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
    console.log("📞 Twilio Connection Established");

    let streamSid = null;
    let geminiWs = new WebSocket(GEMINI_URL);
    let isAiSpeaking = false; // Flag to prevent echo

    // A. Connect to Gemini
    geminiWs.on('open', () => {
      console.log("✨ Connected to Gemini API");
      
      // Setup
      geminiWs.send(JSON.stringify({
        setup: {
          model: MODEL_NAME,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } }
          }
        }
      }));

      // Initial Greeting
      const msg = {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Hello, please introduce yourself." }] }],
          turnComplete: true
        }
      };
      geminiWs.send(JSON.stringify(msg));
    });

    // B. Handle Gemini Messages
    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        // 1. Audio Output (Gemini -> Twilio)
        if (response.serverContent && response.serverContent.modelTurn) {
          response.serverContent.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
              if (streamSid) {
                isAiSpeaking = true; // AI is talking, so we expect echo
                
                const pcm24k = Buffer.from(part.inlineData.data, 'base64');
                const pcm8k = downsample24kTo8k(pcm24k);
                const mulaw8k = pcmToMulaw(pcm8k);
                
                connection.socket.send(JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: mulaw8k.toString('base64') }
                }));
              }
            }
          });
        }

        // 2. Interruption Handling (User interrupted AI)
        if (response.serverContent && response.serverContent.interrupted) {
          console.log("🛑 Interrupted! Clearing Twilio Buffer.");
          if (streamSid) {
            // Send "clear" to Twilio to stop playback immediately
            connection.socket.send(JSON.stringify({ 
              event: "clear", 
              streamSid 
            }));
          }
          isAiSpeaking = false; // Reset flag
        }

        // 3. Turn Complete
        if (response.serverContent && response.serverContent.turnComplete) {
          isAiSpeaking = false; // AI finished talking
        }

      } catch (e) {
        console.error("Gemini Error:", e);
      }
    });

    geminiWs.on('close', () => console.log("Gemini Closed"));

    // C. Handle Twilio Messages (Twilio -> Gemini)
    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
        
        } else if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
          // OPTIONAL: Stop listening while AI is speaking (Basic Echo Cancellation)
          // You can comment this 'if' out if you want to allow talking over the AI
          if (!isAiSpeaking) { 
            const mulaw8k = Buffer.from(data.media.payload, 'base64');
            const pcm8k = mulawToPcm(mulaw8k);
            const pcm16k = upsample8kTo16k(pcm8k); // Using new robust upsampler

            geminiWs.send(JSON.stringify({
              realtimeInput: {
                mediaChunks: [{
                  mimeType: "audio/pcm;rate=16000",
                  data: pcm16k.toString('base64')
                }]
              }
            }));
          }
        } else if (data.event === 'stop') {
          console.log("⏹️ Call Ended");
          geminiWs.close();
        }
      } catch (e) {
        console.error("Twilio Error:", e);
      }
    });
  });
});

// --- ROBUST AUDIO MATH (Integer Based) ---

// 1. Upsample 8k -> 16k (Double the samples with smoothing)
function upsample8kTo16k(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Int16Array(input.length * 2);
  
  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    const next = (i < input.length - 1) ? input[i + 1] : current;
    
    output[i * 2] = current;
    // Average the current and next sample for the "in-between" sample
    output[i * 2 + 1] = Math.floor((current + next) / 2); 
  }
  return Buffer.from(output.buffer);
}

// 2. Downsample 24k -> 8k (Take every 3rd sample)
function downsample24kTo8k(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Int16Array(Math.floor(input.length / 3));
  
  for (let i = 0; i < output.length; i++) {
    output[i] = input[i * 3];
  }
  return Buffer.from(output.buffer);
}

// 3. Mu-Law Table-Based Decoding (Fast & Accurate)
// (Replacing formula with a standard G.711 approach for reliability)
const BIAS = 0x84;
const CLIP = 32635;

function pcmToMulaw(buffer) {
  const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const mulaw = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) mulaw[i] = encodeMuLaw(pcm[i]);
  return Buffer.from(mulaw);
}

function mulawToPcm(buffer) {
  const pcmBuffer = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) pcmBuffer[i] = decodeMuLaw(buffer[i]);
  return Buffer.from(pcmBuffer.buffer);
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

// Start
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`🚀 Server listening on ${address}`);
});