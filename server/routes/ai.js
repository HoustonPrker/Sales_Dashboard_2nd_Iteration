// ============================================================
// AI route — Anthropic streaming SSE
// POST /proxy/ai
// ============================================================

const express = require('express');
const router  = express.Router();

router.post('/', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic({ apiKey });

    const { messages, system, model } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control',  'no-cache');
    res.setHeader('Connection',     'keep-alive');
    res.flushHeaders();

    const stream = client.messages.stream({
      model:      model || 'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     system || 'You are a helpful sales intelligence assistant.',
      messages,
    });

    stream.on('text', chunk => {
      res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
    });

    await stream.finalMessage();
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    console.error('/proxy/ai error:', e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
      res.end();
    }
  }
});

module.exports = router;
