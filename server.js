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
    const modelClient = ai.getGenerativeModel({ model });

    const result = await modelClient.generateContent(prompt);
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
    const modelClient = ai.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const result = await modelClient.generateContent({
      contents: [
        { role: 'user', parts: [{ text }] },
      ],
      generationConfig: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { name: voiceName },
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
  let liveSession = null;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'connect') {
        const { voiceName = 'Puck', topic = 'daily life', apiKey } = message.config || {};

        ai = createAiClient(apiKey);
        const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

        const systemInstruction = `You are a friendly, patient American English tutor named "Sam".
Speak clearly and help the user practice speaking. Topic: ${topic}.`;

        liveSession = await model.startChat({
          systemInstruction,
        });

        ws.send(JSON.stringify({ type: 'connected' }));
      } else if (message.type === 'audio-input') {
        // TODO: integrate real Gemini Live audio streaming.
      } else if (message.type === 'disconnect') {
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
