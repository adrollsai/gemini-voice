import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';
import { WaveFile } from 'wavefile'; // Professional Audio Handling

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ status: "OK", system: "Gemini 2.5 Bridge" }));

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

    // Connect to Gemini
    geminiWs.on('open', () => {
      console.log("✨ Connected to Gemini");

      // A. Setup Message (Snake Case Required)
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

    // Handle Gemini Messages
    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        // 1. Audio Output (Gemini -> Twilio)
        if (response.server_content && response.server_content.model_turn) {
          response.server_content.model_turn.parts.forEach(part => {
            if (part.inline_data && part.inline_data.mime_type.startsWith('audio/pcm')) {
              // Convert 24k PCM -> 8k Mu-Law
              const pcm24k = Buffer.from(part.inline_data.data, 'base64');
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

        // 2. Interruption
        if (response.server_content && response.server_content.interrupted) {
          console.log("🛑 Gemini Interrupted");
          if (streamSid) connection.socket.send(JSON.stringify({ event: "clear", streamSid }));
        }
      } catch (e) {
        console.error("Gemini Error:", e);
      }
    });

    geminiWs.on('close', () => console.log("Gemini Disconnected"));

    // Handle Twilio Messages
    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
        } else if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
          
          // 1. Get Audio Chunk (Mu-Law)
          const mulawChunk = Buffer.from(data.media.payload, 'base64');
          
          // 2. Convert to PCM 16kHz (Using WaveFile for accuracy)
          // Matches Scala: Twilio(8k) -> Gemini(16k)
          const pcm16k = convertMulaw8kToPcm16k(mulawChunk);

          // 3. Send to Gemini (No Buffering, Realtime)
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

// --- PROFESSIONAL AUDIO CONVERSION (Using WaveFile) ---

/**
 * Converts Twilio Mu-Law (8kHz) to Gemini PCM (16kHz)
 * Matches Scala `AudioConverter.twilioToGeminiStream`
 */
function convertMulaw8kToPcm16k(mulawBuffer) {
  // 1. Create a WaveFile instance from the Mu-Law data
  const wav = new WaveFile();
  
  // Twilio sends raw Mu-Law chunks without headers. 
  // We must construct a valid container to use the library's conversion.
  wav.fromScratch(1, 8000, '8m', mulawBuffer);
  
  // 2. Decode Mu-Law to 16-bit PCM
  wav.fromMuLaw(); 
  
  // 3. Resample from 8000Hz to 16000Hz
  // This uses proper interpolation, unlike manual math
  wav.toSampleRate(16000); 

  // 4. Extract the raw samples
  // wavefile returns samples as Float64 or Int depending on internal state.
  // We ensure we get a Buffer of Int16 Little Endian bytes.
  return Buffer.from(wav.toBuffer()).subarray(44); // Remove 44-byte WAV header
}

/**
 * Converts Gemini PCM (24kHz) to Twilio Mu-Law (8kHz)
 * Matches Scala `AudioConverter.geminiToTwilioStream`
 */
function convertPcm24kToMulaw8k(pcmBuffer) {
  const wav = new WaveFile();
  
  // Gemini sends raw 16-bit PCM at 24kHz
  wav.fromScratch(1, 24000, '16', pcmBuffer);
  
  // 1. Resample to 8000Hz
  wav.toSampleRate(8000);
  
  // 2. Encode to Mu-Law
  wav.toMuLaw();
  
  // 3. Return raw bytes (skip header)
  return Buffer.from(wav.toBuffer()).subarray(44);
}

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`🚀 Server listening on ${address}`);
});