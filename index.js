const express = require('express');
const app = express();

// Capture the raw request body as a Buffer before any other parser runs.
// This is essential for diagnosing printers (e.g. Epson TM-T88VI) that may
// send XML, plain-text, or other non-JSON content types that the standard
// parsers silently ignore.
app.use((req, res, next) => {
  let chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks).toString('utf-8');
    next();
  });
  req.on('error', next);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  return res;
}

app.post('/print', async (req, res) => {
  const location = req.query.location || 'Peterhead';
  const contentType = req.headers['content-type'] || '(none)';

  // ── Debug logging ────────────────────────────────────────────────────────
  console.log('[/print] ── incoming request ──────────────────────────────');
  console.log('[/print] content-type :', contentType);
  console.log('[/print] all headers  :', JSON.stringify(req.headers, null, 2));
  console.log('[/print] raw body     :', req.rawBody || '(empty)');
  // ────────────────────────────────────────────────────────────────────────

  // Attempt to derive a usable body object from whatever the printer sent.
  // Priority: express-parsed body → JSON parse of raw → XML field extraction.
  let body = {};

  if (req.body && Object.keys(req.body).length > 0) {
    // express.json() or express.urlencoded() already parsed it
    body = req.body;
    console.log('[/print] parsed body  :', JSON.stringify(body, null, 2));
  } else if (req.rawBody) {
    const raw = req.rawBody.trim();

    // Try JSON
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        body = JSON.parse(raw);
        console.log('[/print] parsed body (json fallback):', JSON.stringify(body, null, 2));
      } catch (e) {
        console.log('[/print] JSON parse failed:', e.message);
      }
    }

    // Try extracting key XML attributes / elements that the Epson SDK sends
    if (!body.ConnectionType) {
      const connMatch = raw.match(/<ConnectionType[^>]*>([^<]+)<\/ConnectionType>|ConnectionType=["']?([^"'&\s]+)/i);
      if (connMatch) {
        body.ConnectionType = connMatch[1] || connMatch[2];
      }
      const respMatch = raw.match(/<ResponseFile[^>]*>([\s\S]*?)<\/ResponseFile>/i);
      if (respMatch) body.ResponseFile = respMatch[1];
      if (body.ConnectionType) {
        console.log('[/print] parsed body (xml fallback):', JSON.stringify(body, null, 2));
      }
    }

    if (!body.ConnectionType) {
      console.log('[/print] could not determine ConnectionType — raw body logged above for inspection');
    }
  }

  if (body.ConnectionType === 'GetRequest') {
    const sbRes = await sbFetch(`/rest/v1/print_jobs?location=eq.${encodeURIComponent(location)}&status=eq.pending&order=created_at.asc&limit=1`);
    const jobs = await sbRes.json();

    if (!Array.isArray(jobs) || jobs.length === 0) {
      res.set('Content-Type', 'text/xml; charset=utf-8');
      return res.status(200).send('');
    }

    const job = jobs[0];
    await sbFetch(`/rest/v1/print_jobs?id=eq.${job.id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'printing' })
    });

    const content = job.content.replace(/\n/g, '&#10;');
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<PrintRequestInfo Version="2.00">
  <ePOSPrint>
    <Parameter>
      <devid>local_printer</devid>
      <timeout>30</timeout>
    </Parameter>
    <PrintData>
      ${content}
    </PrintData>
  </ePOSPrint>
</PrintRequestInfo>`;

    console.log('Sending job', job.id, 'to', location);
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.set('Content-Length', Buffer.byteLength(xml, 'utf-8'));
    res.set('Connection', 'close');
    return res.status(200).send(xml);
  }

  if (body.ConnectionType === 'SetResponse') {
    const responseFile = body.ResponseFile || '';
    const success = responseFile.includes('success="true"');
    const code = responseFile.match(/code="([^"]+)"/)?.[1];
    console.log('SetResponse', location, 'success:', success, 'code:', code);
    await sbFetch(`/rest/v1/print_jobs?location=eq.${encodeURIComponent(location)}&status=eq.printing&order=created_at.asc&limit=1`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: success ? 'printed' : 'failed', printed_at: new Date().toISOString() })
    });
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.status(200).send('');
  }

  res.set('Content-Type', 'text/xml; charset=utf-8');
  return res.status(200).send('');
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Print server running on port ${PORT}`));
