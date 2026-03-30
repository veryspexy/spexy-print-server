const express = require('express');
const app = express();

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
  try {
    const location = req.query.location || 'Peterhead';
    const body = req.body || {};

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

      const safeContent = job.content.replace(/\n/g, '').replace(/\r/g, '');
      const xml = '<?xml version="1.0" encoding="utf-8"?><PrintRequestInfo Version="2.00"><ePOSPrint><Parameter><devid>local_printer</devid><timeout>30</timeout></Parameter><PrintData>' + safeContent + '</PrintData></ePOSPrint></PrintRequestInfo>';

      console.log('Sending job', job.id, 'to', location, 'xml length:', xml.length);
      res.set('Content-Type', 'text/xml; charset=utf-8');
      res.set('Content-Length', Buffer.byteLength(xml, 'utf-8'));
      res.set('Connection', 'close');
      return res.status(200).send(xml);
    }

    if (body.ConnectionType === 'SetResponse') {
      const responseFile = body.ResponseFile || '';
      const success = responseFile.includes('success="true"');
      const code = responseFile.match(/code="([^<]+)"/)?.[1];
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
  } catch(e) {
    console.error('Print handler error:', e.message);
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.status(200).send('');
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Print server running on port ${PORT}`));
