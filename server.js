import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-09-2025';

function createAiClient(apiKey) {
  if (!apiKey) {
    throw new Error('Missing Gemini API key');
  }
  return new GoogleGenAI({ apiKey });
}

// Fallback TTS using system voices
function generateSystemTTS(text, voice) {
  return new Promise((resolve, reject) => {
    const voiceMap = {
      'Aoede': 'Samantha',    // macOS female voice
      'Charon': 'Alex',       // macOS male voice  
      'Fenrir': 'Bruce',      // macOS deep male voice
      'Kore': 'Karen',        // macOS female voice
      'Puck': 'Daniel',       // macOS male voice
      'Orion': 'Alex'         // macOS fallback
    };
    
    const systemVoice = voiceMap[voice] || 'Karen';
    const tempFile = path.join(process.cwd(), `temp_${Date.now()}.aiff`);
    
    const command = process.platform === 'darwin' 
      ? `say -v "${systemVoice}" -o "${tempFile}" "${text}"`
      : `echo "${text}" | festival --tts`;
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('System TTS error:', error);
        reject(error);
        return;
      }
      
      if (process.platform === 'darwin' && fs.existsSync(tempFile)) {
        // Convert AIFF to base64
        const audioBuffer = fs.readFileSync(tempFile);
        const audioBase64 = audioBuffer.toString('base64');
        fs.unlinkSync(tempFile); // Clean up
        resolve(audioBase64);
      } else {
        reject(new Error('TTS generation failed'));
      }
    });
  });
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Erica Node Backend Proxy', version: '1.0.0' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, model = 'gemini-3.0-flash', apiKey } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt in request body' });
    }

    const ai = createAiClient(apiKey);
    const result = await ai.models.generateContent({
      model,
      contents: prompt,
    });
    const text = result.response?.text() ?? '';

    res.json({ text });
  } catch (error) {
    console.error('Error in /api/generate:', error);
    res.status(500).json({ error: 'Failed to generate content', details: String(error) });
  }
});

app.post('/api/generate-tts', async (req, res) => {
  try {
    const { text, voice: voiceRaw = 'Puck', apiKey } = req.body;
    const voice = typeof voiceRaw === 'string' ? (voiceRaw.trim() || 'Puck') : 'Puck';
    
    console.log(`TTS Request - voice: ${voice}, text: "${text.substring(0, 50)}..."`);

    if (!text) {
      return res.status(400).json({ error: 'Missing text in request body' });
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'Missing Gemini API key' });
    }

    let audioBase64 = '';
    let audioMimeType = '';
    
    try {
      // Use gemini-2.0-flash-exp for TTS generation (supports audio modality)
      const ai = createAiClient(apiKey);
      
      console.log(`Using Gemini TTS with voice: ${voice}`);
      
      const result = await ai.models.generateContent({
        model: 'gemini-2.0-flash-exp',
        contents: [
          { role: 'user', parts: [{ text }] },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      });

      const audioData = result.response?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      audioBase64 = audioData?.data ?? '';
      audioMimeType = audioData?.mimeType ?? '';
      
      if (!audioBase64) {
        throw new Error('No audio data from Gemini');
      }
      
      console.log('Gemini TTS successful');
      
    } catch (geminiError) {
      console.log('Gemini TTS failed:', geminiError.message);

      // Fallback to system TTS only on macOS (Render/Linux typically won't have festival)
      if (process.platform !== 'darwin') {
        throw geminiError;
      }

      audioBase64 = await generateSystemTTS(text, voice);
      audioMimeType = 'audio/aiff';
      console.log('System TTS fallback successful');
    }

    res.json({ audioBase64, audioMimeType });
  } catch (error) {
    console.error('Error in /api/generate-tts:', error);
    res.status(500).json({ error: 'Failed to generate TTS', details: String(error) });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/api/live' });

wss.on('connection', (ws) => {
  console.log('Client connected to /api/live');

  let ai = null;
  let liveSessionPromise = null;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'connect') {
        const { voiceName: voiceNameRaw = 'Puck', userName = 'Student', apiKey } = message.config || {};
        const voiceName = typeof voiceNameRaw === 'string' ? (voiceNameRaw.trim() || 'Puck') : 'Puck';

        if (!apiKey) {
          ws.send(JSON.stringify({ type: 'error', error: 'Missing API key' }));
          return;
        }

        try {
          ai = new GoogleGenAI({ apiKey });

          const systemInstruction = `### ROLE
You are "Erica", a high-performance AI Language Coach specializing in American English immersion. Your personality is encouraging, patient, and intellectually sharp.

### USER PROFILE
Target Name: "${userName}". Always address the user by name to build rapport.
Adaptively assess the user's CEFR level (A1-C2) in every turn. 

### CORE OPERATING INSTRUCTIONS
1. PROTOCOL DE CORRECCIÓN (Strict Hierarchy):
   - Prioritize "High-Impact Errors": Those that impede understanding or sound very unnatural.
   - PHONETIC FOCUS: Since this is a voice interaction, detect and correct "Word Stress" (e.g., 'RE-cord' vs 're-CORD') and "Connected Speech" (e.g., 'wanna', 'gonna', 'coulda').
   - LANGUAGE SWITCH: ALWAYS explain the 'Why' in Spanish (concise and clear) and the 'How' in English.

2. STRUCTURE OF RESPONSE:
   - [Acknowledgment]: Natural, brief reaction to what the user said.
   - [The Correction]: Use the "Sandwich Method". 
     * Spanish: "Para sonar más natural, decimos..." 
     * English: "I'm going to the store" (Model the correct pronunciation clearly).
   - [Guided Practice]: Ask a follow-up question that forces the user to use the corrected structure immediately.

3. CONTEXTUAL ADAPTATION:
   - BEGINNER: Use the Top 1000 most frequent words. Slow tempo.
   - INTERMEDIATE: Introduce Phrasal Verbs and Idioms naturally.
   - ADVANCED: Focus on Nuance, Tone (Formal vs Informal), and Figures of Speech.

### TECHNICAL GUIDELINES (Native Audio Optimization)
- Speak with natural prosody. Use contractions (it's, they're) to sound like a native.
- If the user struggles with a word, break it down phonetically in the audio: "Re-peat with me: Pho-to-graph-er."
- Keep your turns under 40 words to maximize User Speaking Time (UST).

### GOAL
Transform "${userName}" into a confident speaker by balancing 80% encouragement and 20% rigorous linguistic correction.`;

          liveSessionPromise = ai.live.connect({
            model: GEMINI_LIVE_MODEL,
            callbacks: {
              onopen: () => {
                console.log('Connected to Gemini Live');
                ws.send(JSON.stringify({ type: 'connected' }));
              },
              onmessage: (message) => {
                try {
                  const serverContent = message.serverContent;
                  ws.send(JSON.stringify({
                    type: 'gemini-message',
                    data: { serverContent },
                  }));
                } catch (err) {
                  console.error('Error forwarding message to client:', err);
                }
              },
              onclose: () => {
                console.log('Gemini Live session closed');
                ws.send(JSON.stringify({ type: 'disconnected' }));
              },
              onerror: (err) => {
                console.error('Gemini Live session error:', err);
                ws.send(JSON.stringify({ type: 'error', error: String(err) }));
              },
            },
            config: {
              responseModalities: [Modality.AUDIO],
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction: { parts: [{ text: systemInstruction }] },
              generationConfig: {
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName } },
                },
              },
            },
          });
        } catch (err) {
          console.error('Failed to connect to Gemini:', err);
          ws.send(JSON.stringify({ type: 'error', error: 'Failed to connect to Gemini: ' + String(err) }));
        }

      } else if (message.type === 'audio-input') {
        if (liveSessionPromise) {
          try {
            const { audioData, mimeType } = message;
            liveSessionPromise.then((session) => {
              if (session && typeof session.sendRealtimeInput === 'function') {
                session.sendRealtimeInput({
                  media: { data: audioData, mimeType },
                });
              }
            });
          } catch (err) {
            console.error('Error sending audio to Gemini:', err);
          }
        }
      } else if (message.type === 'disconnect') {
        if (liveSessionPromise) {
          liveSessionPromise.then((session) => {
            if (session && typeof session.close === 'function') {
              session.close();
            }
          });
          liveSessionPromise = null;
        }
        ws.close();
      }
    } catch (error) {
      console.error('Error handling WS message:', error);
      ws.send(JSON.stringify({ type: 'error', error: String(error) }));
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`HTTP server listening on http://localhost:${PORT}`);
  console.log(`WebSocket Live API available at ws://localhost:${PORT}/api/live`);
});
