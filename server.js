import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

function createAiClient(apiKey) {
  if (!apiKey) {
    throw new Error('Missing Gemini API key');
  }
  return new GoogleGenAI({ apiKey });
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
    const { prompt, model = 'gemini-2.0-flash-exp', apiKey } = req.body;

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
    const { text, voiceName = 'Puck', apiKey } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Missing text in request body' });
    }

    const ai = createAiClient(apiKey);
    const result = await ai.models.generateContent({
      // Modelo de texto-a-audio soportado por generateContent en v1beta
      model: 'gemini-2.0-flash-exp',
      contents: [
        { role: 'user', parts: [{ text }] },
      ],
      generationConfig: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          // Voces predefinidas de Gemini: "Zephyr", "Puck", "Charon", "Kore", "Fenrir", etc.
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
    });

    const audioData = result.response?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    const audioBase64 = audioData?.data ?? '';

    res.json({ audioBase64 });
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
        const { voiceName = 'Puck', topic = 'Student', apiKey } = message.config || {};

        if (!apiKey) {
          ws.send(JSON.stringify({ type: 'error', error: 'Missing API key' }));
          return;
        }

        try {
          ai = new GoogleGenAI({ apiKey });

          const systemInstruction = `You are a friendly, patient but rigorous American English tutor named "Sam".
Your primary goal is to help the user speak natural, clear American English at a near-native level.
Always pay close attention to: pronunciation, word stress, intonation, grammar, sentence structure, vocabulary choice, and overall fluency.
The user's name is: "${topic}". Call the user by their name frequently in a natural way.

First, infer the user's approximate level (beginner / intermediate / advanced) from their English: vocabulary, grammar, fluency, and pronunciation.
Adapt your teaching style to that level:
- For BEGINNERS: use very simple English, short sentences, basic vocabulary, and speak slowly.
- For INTERMEDIATE learners: use everyday English, slightly longer sentences, and introduce some new vocabulary.
- For ADVANCED learners: use natural, fluent American English with more complex structures and richer vocabulary.

When the user speaks:
- Gently correct pronunciation and accent (individual sounds, word stress, connected speech).
- Correct grammar and sentence structure, and suggest more natural alternatives in American English.
- ALWAYS explain the mistake in Spanish, but give the corrected example in English.
  Example format: "Explicación en español... Por ejemplo: 'Correct sentence in English'."
- Provide very short examples the user can repeat (1–2 sentences) when needed.

Be very encouraging and kind, but do not ignore mistakes: always correct important errors in a clear and simple way.
Keep each response concise so the conversation remains interactive and the user can practice speaking a lot.`;

          liveSessionPromise = ai.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-09-2025',
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
              systemInstruction,
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName } },
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
