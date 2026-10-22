// Snap & Identify — Mechanical AI : backend
require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first'); // avoids hangs on networks with broken IPv6
const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash'; // vision-capable Flash model

const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.7-flash'; // backup if the main model is busy
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQUEST_TIMEOUT_MS = 35000; // never wait on Gemini longer than this per attempt
let activeModel = null; // remembers the model that last worked
const noThinking = new Set(); // models that rejected the thinking setting

// Gemini 3 models "think" before answering; level "low" keeps replies fast
function withThinking(body, on) {
  if (!on) return body;
  const o = JSON.parse(body);
  o.generationConfig = { ...(o.generationConfig || {}), thinkingConfig: { thinkingLevel: 'low' } };
  return JSON.stringify(o);
}

// Ask Google which Flash models THIS API key can use ("model not found" fix), newest first
async function discoverModels() {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('ListModels HTTP ' + r.status);
  const names = ((await r.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((n) => /flash/i.test(n) && !/image|tts|live|audio|embed|robot|computer/i.test(n));
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const isPre = (n) => (/preview|exp/.test(n) ? 1 : 0);
  const isLite = (n) => (/lite/.test(n) ? 1 : 0);
  names.sort((a, b) => isLite(a) - isLite(b) || ver(b) - ver(a) || isPre(a) - isPre(b) || a.length - b.length);
  console.log('Flash models available for your key:', names.slice(0, 6).join(', ') || '(none)');
  return names.slice(0, 8);
}

// Calls Gemini with a timeout.
//  - busy errors (429/500/503): retried once, then the next model is tried
//  - 404 "model not found": the available models are looked up and tried instead
//  - timeout/network problem: skips to the next model
async function geminiFetch(init) {
  const first = activeModel || MODEL;
  let queue = [first, FALLBACK_MODEL].filter(Boolean);
  const tried = new Set();
  let discovered = false, res = null, lastErr = null;
  while (queue.length) {
    const model = queue.shift();
    if (tried.has(model)) continue;
    tried.add(model);
    const tries = model === first ? 2 : 1;
    for (let i = 0; i < tries; i++) {
      const t0 = Date.now();
      try {
        const useThinking = !noThinking.has(model);
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { ...init, body: withThinking(init.body, useThinking), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        console.log(`Gemini ${model}: HTTP ${res.status} in ${Date.now() - t0} ms`);
        if (res.ok) { activeModel = model; return res; }
        lastErr = null;
        if (res.status === 400 && useThinking) { // setting not supported by this model: retry without it
          noThinking.add(model); i--; continue;
        }
        if (res.status === 404 || res.status === 429) break; // not available / quota used up: try the next model
        if (![429, 500, 503].includes(res.status)) return res;
      } catch (e) {
        lastErr = e; res = null;
        console.warn(`Gemini ${model} failed (${e.name}) after ${Date.now() - t0} ms`);
        break;
      }
      if (i < tries - 1) await sleep(1500);
    }
    if (res && [404, 429].includes(res.status) && !discovered) {
      discovered = true;
      try { queue = [...(await discoverModels()), ...queue]; }
      catch (e) { console.warn('Could not list models:', e.message); }
    }
  }
  console.warn('Hint: run  node test-gemini.js  to check your connection to Google.');
  if (res) return res;
  throw lastErr || new Error('No response from Gemini');
}


// Keep uploads in memory (no files written to disk), max 8 MB, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('NOT_IMAGE')),
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'), // always load the newest files
}));

// The exact prompt required by the brief
const PROMPT = `You are a mechanical engineering tutor.

Identify the most likely mechanical component shown in the image.
Possible components include: gear, bearing, pulley, shaft, bolt, nut, washer,
spring, coupling, chain, key, rivet, or other mechanical part.

Carefully analyze visible shape, teeth, holes, threads, grooves, symmetry,
and surrounding parts.

If the image is blurry, dark, cropped, partially visible, or unclear, clearly state
that identification is uncertain. Do not invent a component name.

Return only valid JSON in this exact structure:
{
  "component_name": "string",
  "confidence": "High" | "Medium" | "Low",
  "function": "string",
  "applications": "string",
  "visible_features": "string",
  "image_quality_note": "string"
}

Rules:
- component_name: most likely component name, or 'Unable to identify' if unclear.
- confidence: High, Medium, or Low.
- function: simple beginner-friendly explanation of what the component does.
- applications: 2-4 common real-world applications.
- visible_features: visible identifying features observed in the image.
- image_quality_note: explain any issue with image clarity, lighting, angle, or focus.
- Keep all explanations short, clear, and suitable for engineering students.`;

// Parse the model's text into validated JSON (tolerates ```json fences)
function parseAiJson(text) {
  const cleaned = String(text).replace(/```json|```/gi, '').trim();
  const data = JSON.parse(cleaned);
  const conf = ['High', 'Medium', 'Low'].includes(data.confidence) ? data.confidence : 'Low';
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : 'Not available');
  if (typeof data.component_name !== 'string') throw new Error('Missing component_name');
  return {
    component_name: str(data.component_name),
    confidence: conf,
    function: str(data.function),
    applications: str(data.applications),
    visible_features: str(data.visible_features),
    image_quality_note: str(data.image_quality_note),
  };
}

// POST /api/identify — receives the image, calls Gemini, returns cleaned JSON
app.post('/api/identify', upload.single('image'), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set in .env');
      return res.status(500).json({ error: 'Analysis failed. Please try again.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Please select or capture an image first.' });

    // Convert image to Base64 for Gemini's inline image format
    console.log(`Identify request: ${req.file.mimetype}, ${Math.round(req.file.size / 1024)} KB`);
    const base64 = req.file.buffer.toString('base64');
    const apiRes = await geminiFetch({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: req.file.mimetype, data: base64 } },
            { text: PROMPT },
          ],
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });

    if (!apiRes.ok) {
      console.error('Gemini error', apiRes.status, await apiRes.text());
      const quota = apiRes.status === 429;
      const busy = apiRes.status === 503;
      return res.status(502).json({ error: quota
        ? 'Analysis failed. Your Gemini API quota is used up for now. Wait a few minutes and try again.'
        : busy ? 'Analysis failed. The AI service is busy, please try again in a minute.' : 'Analysis failed. Please try again.' });
    }

    const payload = await apiRes.json();
    const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (!text) return res.status(502).json({ error: 'Analysis failed. Please try again.' });

    try {
      return res.json(parseAiJson(text));
    } catch (e) {
      console.error('Invalid AI JSON:', text);
      return res.status(502).json({ error: 'The AI returned an unreadable answer. Please try again.' });
    }
  } catch (err) {
    console.error(err);
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError' || (err.cause && err.cause.code));
    res.status(500).json({ error: timedOut
      ? 'Analysis failed. The AI service did not respond. Check your internet connection and try again.'
      : 'Analysis failed. Please try again.' });
  }
});

// Ask Gemini a text-only question and return the raw text answer
async function askGeminiText(prompt) {
  const r = await geminiFetch({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.9 },
    }),
  });
  if (!r.ok) throw new Error('Gemini ' + r.status + ' ' + (await r.text()));
  const p = await r.json();
  return p?.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || '';
}

// Validate the quiz JSON: exactly 3 questions, 4 options each, valid answer index
function parseQuiz(text) {
  const arr = JSON.parse(String(text).replace(/```json|```/gi, '').trim());
  if (!Array.isArray(arr) || arr.length < 3) throw new Error('Need 3 questions');
  return arr.slice(0, 3).map((q) => {
    const ok = q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length === 4 &&
      q.options.every((o) => typeof o === 'string') && Number.isInteger(q.answer_index) &&
      q.answer_index >= 0 && q.answer_index <= 3 && typeof q.explanation === 'string';
    if (!ok) throw new Error('Bad question format');
    return { question: q.question, options: q.options, answer_index: q.answer_index, explanation: q.explanation };
  });
}

// POST /api/quiz — creates 3 multiple-choice questions about the identified component
app.post('/api/quiz', express.json({ limit: '10kb' }), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'Quiz failed.' });
    // Clean the name (it comes from the browser): short, single line, no quotes
    const name = String(req.body?.component_name || '').replace(/["\n\r]/g, ' ').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Component name is required.' });

    // Clean text coming from the browser: single line, no quotes, limited length
    const clean = (key, n = 400) => String(req.body?.[key] || '').replace(/[\r\n"]+/g, ' ').trim().slice(0, n);
    const info = `Component: ${name}
Function: ${clean('function')}
Applications: ${clean('applications')}
Visible features: ${clean('visible_features')}`;

    const prompt = `You are a mechanical engineering tutor.
A student just identified a component from a photo. This is the information the app showed them:
${info}

Variation code (use it to vary the questions each time): ${Math.random().toString(36).slice(2, 8)}
Create exactly 3 multiple-choice questions that test whether the student understood THIS information:
one about the function, one about the applications, and one about the visible identifying features.
Each question has exactly 4 options and exactly one correct answer. Vary the position of the correct answer.
Make wrong options plausible but clearly wrong. Do not ask about anything not covered by the information above.
Return only a valid JSON array in this exact structure:
[{"question":"string","options":["string","string","string","string"],"answer_index":0,"explanation":"string"}]
answer_index is the 0-based index of the correct option. Keep questions and explanations short and clear.`;

    const text = await askGeminiText(prompt);
    res.json({ questions: parseQuiz(text) });
  } catch (err) {
    console.error('Quiz error:', err.message);
    res.status(502).json({ error: 'Quiz failed. Showing the general quiz.' });
  }
});

// Friendly handling of upload errors (wrong type, too large)
app.use((err, req, res, next) => {
  if (err.message === 'NOT_IMAGE') return res.status(400).json({ error: 'Please upload an image file.' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image is too large (max 8 MB).' });
  console.error(err);
  res.status(500).json({ error: 'Analysis failed. Please try again.' });
});

// Start the server. If the port is already taken (e.g. the app is already running),
// automatically try the next port instead of crashing.
function start(port, left = 10) {
  const server = app.listen(port, () => {
    console.log(`Snap & Identify running at http://localhost:${port}`);
    // Show the address to open on a phone connected to the same Wi-Fi
    const os = require('os');
    for (const list of Object.values(os.networkInterfaces()))
      for (const n of list || [])
        if (n.family === 'IPv4' && !n.internal) console.log(`On your phone (same Wi-Fi): http://${n.address}:${port}`);
    // start.bat sets OPEN_BROWSER so the page opens on the right port
    if (process.env.OPEN_BROWSER && process.platform === 'win32') require('child_process').exec(`start "" http://localhost:${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && left > 0) {
      console.log(`Port ${port} is busy (the app may already be running). Trying ${port + 1}...`);
      start(port + 1, left - 1);
    } else throw err;
  });
}
start(Number(PORT));
