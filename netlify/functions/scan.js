const https = require('https');

function callClaude(apiKey, imageBase64, mediaType, userPrompt) {
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: userPrompt }
        ]
      },
      { role: 'assistant', content: '{' }
    ]
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) { resolve(null); return; }
          const raw = '{' + parsed.content.map(b => b.text || '').join('');
          const clean = raw.replace(/```json|```/g, '').trim();
          resolve(JSON.parse(clean));
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(requestBody);
    req.end();
  });
}

function isValidVin(vin) {
  return vin && vin.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

function autoCorrect(vin) {
  return vin.toUpperCase().trim().replace(/\s/g,'')
    .replace(/I/g,'1').replace(/O/g,'0').replace(/Q/g,'0');
}

function buildCharConfidence(v1, v2, c1, c2) {
  const score = { HIGH:2, MEDIUM:1, LOW:0 };
  const result = [];
  for (let i = 0; i < 17; i++) {
    const ca = c1[i] || 'MEDIUM';
    const cb = c2[i] || 'MEDIUM';
    if (v1[i] === v2[i]) {
      result.push({ c: v1[i], conf: score[ca] >= score[cb] ? ca : cb });
    } else {
      result.push({ c: score[ca] >= score[cb] ? v1[i] : v2[i], conf: 'LOW' });
    }
  }
  return result;
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

  // ══════════════════════════════════════════════════════
  // PROMPT 1 — ნაბიჯ-ნაბიჯ: პირველ დაათვალიერე, მერე წაიკითხე
  // ══════════════════════════════════════════════════════
  const PROMPT_1 = `STEP 1 - LOCATE: Look carefully at this image. Find text that looks like a vehicle serial number - exactly 17 characters, mix of letters and digits, printed on a label, plate, or sticker on the vehicle.

STEP 2 - READ LITERALLY: Read ONLY what you physically see printed in the image. Do NOT recall or use any VIN you may know. Read the ACTUAL characters printed, one by one, left to right.

STEP 3 - OUTPUT each character and your certainty:
- HIGH: crystal clear, no ambiguity
- MEDIUM: visible but slightly unclear
- LOW: hard to read, uncertain

STRICT RULES:
- Output ONLY what is printed in the image
- Do NOT generate or recall VIN numbers
- If you cannot find a clear 17-char string, set found=false
- Never use letter I (use 1), never use letter O (use 0), never use Q

Output ONLY this JSON:
{
  "found": true,
  "vin": "17 chars you literally see",
  "chars": [{"c":"W","conf":"HIGH"},{"c":"4","conf":"HIGH"}, ... 17 total]
}
Or if not found: {"found": false, "vin": "", "chars": []}`;

  // ══════════════════════════════════════════════════════
  // PROMPT 2 — ვერიფიკაცია: ხელახლა დათვალე და დაადასტურე
  // ══════════════════════════════════════════════════════
  const PROMPT_2 = `Look at this image very carefully.

Your task is to find and transcribe the VIN (Vehicle Identification Number) EXACTLY as it appears printed in this image.

IMPORTANT: You must read what is PHYSICALLY PRINTED in the image. Do not use your memory or training data.

Method:
1. Find the VIN text in the image
2. Read character 1, then character 2, then character 3... up to character 17
3. For each character ask yourself: "Am I reading this from the image, or guessing?"

Confidence levels:
- HIGH = I can clearly see this character in the image
- MEDIUM = I think I see this character but it's a bit unclear
- LOW = I'm not sure what this character is

Common confusions to watch for in the image:
- Is it a zero 0 or letter O? → use 0
- Is it digit 1 or letter I? → use 1  
- Is it digit 8 or letter B? → look carefully
- Is it digit 6 or letter G? → look carefully
- Is it digit 2 or letter Z? → look carefully

Output ONLY this JSON (no other text):
{
  "found": true,
  "vin": "exactly 17 characters as seen in image",
  "chars": [{"c":"X","conf":"HIGH"}, ... 17 entries]
}
If no VIN visible: {"found": false, "vin": "", "chars": []}`;

  const [res1, res2] = await Promise.all([
    callClaude(apiKey, imageBase64, mediaType, PROMPT_1),
    callClaude(apiKey, imageBase64, mediaType, PROMPT_2)
  ]);

  function extract(r) {
    if (!r || !r.found || !r.vin) return null;
    const vin = autoCorrect(r.vin);
    if (!isValidVin(vin)) return null;
    const chars = (r.chars && r.chars.length === 17)
      ? r.chars.map(ch => ({ c: autoCorrect(ch.c||''), conf: ch.conf||'MEDIUM' }))
      : vin.split('').map(c => ({ c, conf: 'MEDIUM' }));
    return { vin, chars };
  }

  const v1 = extract(res1);
  const v2 = extract(res2);

  if (!v1 && !v2) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: false, vin: '', chars: [], confidence: 0, wmi:'', vds:'', vis:'', notes: 'VIN ვერ მოიძებნა. სცადეთ უფრო ახლოდან ან მკაფიოდ გადაღებული ფოტო.' })
    };
  }

  let finalVin, finalChars, matchStatus;

  if (v1 && v2) {
    if (v1.vin === v2.vin) {
      finalVin = v1.vin;
      finalChars = buildCharConfidence(v1.vin, v2.vin, v1.chars.map(c=>c.conf), v2.chars.map(c=>c.conf));
      matchStatus = 'FULL_MATCH';
    } else {
      finalChars = buildCharConfidence(v1.vin, v2.vin, v1.chars.map(c=>c.conf), v2.chars.map(c=>c.conf));
      finalVin = finalChars.map(c=>c.c).join('');
      matchStatus = 'PARTIAL_MATCH';
    }
  } else {
    const only = v1 || v2;
    finalVin = only.vin;
    finalChars = only.chars.map(ch => ({ c: ch.c, conf: ch.conf === 'HIGH' ? 'MEDIUM' : 'LOW' }));
    matchStatus = 'SINGLE_RESULT';
  }

  if (!isValidVin(finalVin)) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: false, vin: '', chars: [], confidence: 0, wmi:'', vds:'', vis:'', notes: 'ამოღებული კოდი ვალიდური VIN არ არის.' })
    };
  }

  const score = { HIGH:2, MEDIUM:1, LOW:0 };
  const avg = finalChars.reduce((s,c) => s + (score[c.conf]||0), 0) / 17;
  const bonus = matchStatus === 'FULL_MATCH' ? 15 : matchStatus === 'PARTIAL_MATCH' ? 0 : -10;
  const confidence = Math.min(99, Math.round(55 + avg * 20 + bonus));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      found: true,
      vin: finalVin,
      chars: finalChars,
      confidence,
      wmi: finalVin.slice(0,3),
      vds: finalVin.slice(3,9),
      vis: finalVin.slice(9,17),
      matchStatus,
      notes: `scan1: ${v1?v1.vin:'fail'} | scan2: ${v2?v2.vin:'fail'} | ${matchStatus}`
    })
  };
};
