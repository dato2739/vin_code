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
          resolve(JSON.parse(raw.replace(/```json|```/g,'').trim()));
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

function charScore(conf) {
  return conf === 'HIGH' ? 10 : conf === 'MEDIUM' ? 5 : 1;
}

function buildCharConfidence(v1, v2, c1, c2) {
  const result = [];
  for (let i = 0; i < 17; i++) {
    const s1 = charScore(c1[i]);
    const s2 = charScore(c2[i]);
    if (v1[i] === v2[i]) {
      const best = s1 >= s2 ? c1[i] : c2[i];
      result.push({ c: v1[i], conf: best });
    } else {
      result.push({ c: s1 >= s2 ? v1[i] : v2[i], conf: 'LOW' });
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

  // ══════════════════════════════════════════════════════════════
  // PROMPT 1 — პირდაპირი წაკითხვა
  // ══════════════════════════════════════════════════════════════
  const PROMPT_1 = `Find the VIN (Vehicle Identification Number) in this image and read it exactly.

The VIN may appear:
- On a windshield (dashboard reflection through glass)
- On a door jamb sticker/label
- On a metal plate
- Embossed on chassis
- White or light text on dark background
- Dark text on light background

Read the characters exactly as printed. Do NOT use your training data or memory — read ONLY what you see.

VIN rules:
- Exactly 17 characters
- Letters A-Z (but never I, O, or Q) and digits 0-9
- If you see what looks like letter O in a VIN context → it is digit 0
- If you see what looks like letter I → it is digit 1

For each character rate your confidence:
- HIGH: clearly readable
- MEDIUM: probably correct but slightly unclear
- LOW: hard to read

Only return found=false if the characters are genuinely unreadable (motion blur, extreme darkness, text too small).

Return ONLY this JSON:
{
  "found": true or false,
  "vin": "17 chars or empty",
  "chars": [{"c":"J","conf":"HIGH"}, ... 17 entries],
  "readable": true or false,
  "reason": "if found=false, explain why"
}`;

  // ══════════════════════════════════════════════════════════════
  // PROMPT 2 — ვერიფიკაცია და ბუნდოვანი სიმბოლოების გარჩევა
  // ══════════════════════════════════════════════════════════════
  const PROMPT_2 = `Look at this image and locate the vehicle's VIN number.

This may be a windshield photo (taken through glass) — that is fine, read the reflected/printed text.

Read the VIN character by character. Pay special attention to:
- 0 (zero) looks similar to D, U — in VINs use 0
- 1 (one) looks similar to L — use 1
- 2 looks similar to Z — look at the top curve
- 8 looks similar to B — count enclosed spaces
- 5 looks similar to S
- 6 looks similar to G

Confidence levels:
- HIGH: no doubt whatsoever
- MEDIUM: fairly sure
- LOW: uncertain

Important: dark background or glass reflection does NOT mean unreadable. Only mark readable=false if the text characters themselves are blurry or indistinct.

Return ONLY this JSON:
{
  "found": true or false,
  "vin": "17 chars or empty",
  "chars": [{"c":"J","conf":"HIGH"}, ... 17 entries],
  "readable": true or false,
  "reason": "if found=false, explain why"
}`;

  const [res1, res2] = await Promise.all([
    callClaude(apiKey, imageBase64, mediaType, PROMPT_1),
    callClaude(apiKey, imageBase64, mediaType, PROMPT_2)
  ]);

  function extract(r) {
    if (!r) return null;
    // readable=false მხოლოდ მაშინ უარვყოთ თუ found=false-ც
    if (!r.found || !r.vin) return null;
    const vin = autoCorrect(r.vin);
    if (!isValidVin(vin)) return null;
    const chars = (r.chars && r.chars.length === 17)
      ? r.chars.map(ch => ({ c: autoCorrect(ch.c || '?'), conf: ch.conf || 'MEDIUM' }))
      : vin.split('').map(c => ({ c, conf: 'MEDIUM' }));
    // მხოლოდ 6+ LOW სიმბოლო → უარი (გავამარტივეთ threshold)
    const lowCount = chars.filter(c => c.conf === 'LOW').length;
    if (lowCount >= 6) return null;
    return { vin, chars };
  }

  const v1 = extract(res1);
  const v2 = extract(res2);

  if (!v1 && !v2) {
    // შევეცადოთ გავიგოთ რატომ ვერ წაიკითხა
    const reason1 = res1?.reason || '';
    const reason2 = res2?.reason || '';
    const readable1 = res1?.readable;
    const readable2 = res2?.readable;

    let msg;
    if (readable1 === false || readable2 === false) {
      msg = 'VIN ტექსტი ბუნდოვანია — შეუძლებელია წაკითხვა.\n\nსცადეთ:\n• უფრო ახლოდან გადაიღეთ\n• კარგი განათება\n• კამერა დააფიქსირეთ (ბუნება)';
    } else {
      msg = 'VIN ვერ მოიძებნა სურათში.\n\nსცადეთ:\n• VIN ნომერი კარგად მოხვდეს კადრში\n• ახლოს გადაიღეთ\n• განათება გაზარდეთ';
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: false, vin: '', chars: [], confidence: 0, wmi:'', vds:'', vis:'', notes: msg })
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
      // PARTIAL_MATCH — 5+ LOW → უარი
      const lowCount = finalChars.filter(c=>c.conf==='LOW').length;
      if (lowCount >= 5) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            found: false, vin: '', chars: [], confidence: 0, wmi:'', vds:'', vis:'',
            notes: 'ორი სკანი განსხვავებულ შედეგს იძლევა.\n\nგთხოვთ კორექტირების ღილაკით ხელით შეიყვანოთ VIN, ან უფრო მკაფიო ფოტო გადაიღოთ.'
          })
        };
      }
    }
  } else {
    const only = v1 || v2;
    finalVin = only.vin;
    finalChars = only.chars.map(ch => ({ c: ch.c, conf: ch.conf === 'HIGH' ? 'MEDIUM' : ch.conf }));
    matchStatus = 'SINGLE_RESULT';
  }

  if (!isValidVin(finalVin)) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: false, vin: '', chars: [], confidence: 0, wmi:'', vds:'', vis:'', notes: 'ამოღებული კოდი ვალიდური VIN არ არის.' })
    };
  }

  const avg = finalChars.reduce((s,c) => s + charScore(c.conf), 0) / 17;
  const bonus = matchStatus === 'FULL_MATCH' ? 15 : matchStatus === 'PARTIAL_MATCH' ? 0 : -5;
  const confidence = Math.min(99, Math.round(55 + avg * 4 + bonus));

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
