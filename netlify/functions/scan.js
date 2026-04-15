const https = require('https');

function callClaude(apiKey, imageBase64, mediaType, prompt) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      },
      { role: 'assistant', content: '{"found":' }
    ]
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (res.statusCode !== 200) { resolve(null); return; }
          const raw = '{"found":' + p.content.map(b => b.text || '').join('');
          resolve(JSON.parse(raw.replace(/```json|```/g, '').trim()));
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

function fix(vin) {
  return (vin || '').toUpperCase().trim().replace(/\s/g, '')
    .replace(/I/g,'1').replace(/O/g,'0').replace(/Q/g,'0');
}

function valid(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'API გასაღები არ არის.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { imageBase64, mediaType } = body;
  if (!imageBase64 || !mediaType) return { statusCode: 400, body: JSON.stringify({ error: 'imageBase64 და mediaType საჭიროა.' }) };

  const P1 = `You are a VIN reader. Find the 17-character Vehicle Identification Number in this image.

The VIN may be on: windshield (through glass), door jamb sticker, chassis plate, or any label.
Dark background is fine. Glass reflection is fine. Read whatever text you can see.

Read each character EXACTLY as printed. Then for each character, rate confidence:
HIGH = clearly visible, no doubt
MEDIUM = visible but slightly unclear  
LOW = hard to read

Never use letters I (→1), O (→0), Q (→0).

Return ONLY JSON, nothing else:
{"found":true,"vin":"17chars","chars":[{"c":"J","conf":"HIGH"},{"c":"M","conf":"HIGH"},...17 total]}
If no VIN: {"found":false,"vin":"","chars":[]}`;

  const P2 = `Find the VIN number in this image. Read it character by character.

Note: dark backgrounds, glass, reflections - these do NOT prevent reading. Focus only on the text.

Watch for these look-alikes:
0 vs D/U, 1 vs L, 2 vs Z, 5 vs S, 6 vs G, 8 vs B

Confidence per character:
HIGH = clearly readable
MEDIUM = fairly sure
LOW = uncertain

Rules: 17 chars, A-Z no I/O/Q, and 0-9.

Return ONLY JSON:
{"found":true,"vin":"17chars","chars":[{"c":"J","conf":"HIGH"},...17 total]}
If no VIN: {"found":false,"vin":"","chars":[]}`;

  const [r1, r2] = await Promise.all([
    callClaude(apiKey, imageBase64, mediaType, P1),
    callClaude(apiKey, imageBase64, mediaType, P2)
  ]);

  function extract(r) {
    if (!r || !r.found || !r.vin) return null;
    const vin = fix(r.vin);
    if (!valid(vin)) return null;
    const chars = (r.chars && r.chars.length === 17)
      ? r.chars.map(ch => ({ c: fix(ch.c || '?')[0] || '?', conf: ch.conf || 'MEDIUM' }))
      : vin.split('').map(c => ({ c, conf: 'MEDIUM' }));
    return { vin, chars };
  }

  const v1 = extract(r1);
  const v2 = extract(r2);

  if (!v1 && !v2) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: false, vin: '', chars: [], confidence: 0,
        wmi: '', vds: '', vis: '',
        notes: 'VIN ვერ მოიძებნა.\nსცადეთ: ახლოდან გადაიღეთ / კარგი განათება / VIN კარგად მოხვდეს კადრში.'
      })
    };
  }

  // შეჯერება — სიმბოლო-დონეზე
  let finalChars, matchStatus;

  if (v1 && v2) {
    if (v1.vin === v2.vin) {
      // სრული დამთხვევა — HIGH
      finalChars = v1.chars.map((ch, i) => {
        const s1 = ch.conf, s2 = v2.chars[i].conf;
        const best = ({HIGH:2,MEDIUM:1,LOW:0}[s1]||0) >= ({HIGH:2,MEDIUM:1,LOW:0}[s2]||0) ? s1 : s2;
        return { c: ch.c, conf: best === 'LOW' ? 'MEDIUM' : 'HIGH' };
      });
      matchStatus = 'FULL_MATCH';
    } else {
      // ნაწილობრივი — სიმბოლო-დონე
      const score = { HIGH:2, MEDIUM:1, LOW:0 };
      finalChars = v1.chars.map((ch, i) => {
        const s1 = score[ch.conf] || 0;
        const s2 = score[v2.chars[i].conf] || 0;
        if (ch.c === v2.chars[i].c) {
          return { c: ch.c, conf: 'HIGH' };
        } else {
          return { c: s1 >= s2 ? ch.c : v2.chars[i].c, conf: 'LOW' };
        }
      });
      matchStatus = 'PARTIAL_MATCH';
    }
  } else {
    const only = v1 || v2;
    finalChars = only.chars.map(ch => ({
      c: ch.c,
      conf: ch.conf === 'HIGH' ? 'MEDIUM' : ch.conf === 'MEDIUM' ? 'MEDIUM' : 'LOW'
    }));
    matchStatus = 'SINGLE_RESULT';
  }

  const finalVin = finalChars.map(c => c.c).join('');
  if (!valid(finalVin)) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: false, vin: '', chars: [], confidence: 0,
        wmi: '', vds: '', vis: '',
        notes: 'ამოღებული კოდი ვალიდური VIN არ არის. გამოიყენეთ კორექტირება.'
      })
    };
  }

  const s = { HIGH:2, MEDIUM:1, LOW:0 };
  const avg = finalChars.reduce((a,c) => a + (s[c.conf]||0), 0) / 17;
  const bonus = matchStatus === 'FULL_MATCH' ? 20 : matchStatus === 'PARTIAL_MATCH' ? 0 : -10;
  const confidence = Math.min(99, Math.round(50 + avg * 20 + bonus));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      found: true, vin: finalVin, chars: finalChars, confidence,
      wmi: finalVin.slice(0,3), vds: finalVin.slice(3,9), vis: finalVin.slice(9,17),
      matchStatus,
      notes: `scan1: ${v1?v1.vin:'—'} | scan2: ${v2?v2.vin:'—'} | ${matchStatus}`
    })
  };
};
