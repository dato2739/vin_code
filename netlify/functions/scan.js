const https = require('https');

function callClaude(apiKey, imageBase64, mediaType, attemptNum) {
  const prompts = [
    // attempt 1 - direct read
    'Look at this image and find the VIN number. Read each character carefully left to right. A VIN is exactly 17 characters using A-Z and 0-9 (never letters I, O, Q). Return ONLY JSON: {"vin": "17 chars or empty", "confidence": 0-100}',
    // attempt 2 - character by character
    'Find the vehicle VIN in this image. Read it character by character, one at a time. Count them: must be exactly 17. Digits are 0-9, letters are A-Z but NOT I, O, or Q. Return ONLY JSON: {"vin": "17 chars or empty", "confidence": 0-100}',
    // attempt 3 - verification focused
    'This image contains a Vehicle Identification Number (VIN). Locate it and transcribe it exactly. Be especially careful distinguishing: 0 (zero) vs letter D or U, 1 (one) vs letter L, 2 vs Z, 8 vs B. VIN = exactly 17 alphanumeric chars, no I O Q. Return ONLY JSON: {"vin": "17 chars or empty", "confidence": 0-100}'
  ];

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: prompts[attemptNum] }
        ]
      },
      { role: 'assistant', content: '{"vin":' }
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
          const raw = '{"vin":' + parsed.content.map(b => b.text || '').join('');
          const clean = raw.replace(/```json|```/g, '').trim();
          const result = JSON.parse(clean);
          resolve(result);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(requestBody);
    req.end();
  });
}

function sanitizeVin(vin) {
  if (!vin) return '';
  return vin.toUpperCase().trim().replace(/\s/g, '');
}

function isValidVin(vin) {
  return vin && vin.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

// სიმბოლო სიმბოლოდ შეადარე და ყველაზე სარწმუნო ავიღოთ
function mergeVins(vins) {
  const valid = vins.filter(v => v && isValidVin(v));
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  // თუ ყველა ერთნაირია
  if (valid.every(v => v === valid[0])) return valid[0];

  // majority vote per character
  let merged = '';
  for (let i = 0; i < 17; i++) {
    const chars = valid.map(v => v[i]);
    const freq = {};
    chars.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
    const best = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    merged += best;
  }
  return isValidVin(merged) ? merged : valid[0];
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API გასაღები კონფიგურირებული არ არის.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { imageBase64, mediaType } = body;
  if (!imageBase64 || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: 'imageBase64 და mediaType საჭიროა.' }) };
  }

  // 3 პარალელური მოთხოვნა
  const results = await Promise.all([
    callClaude(apiKey, imageBase64, mediaType, 0),
    callClaude(apiKey, imageBase64, mediaType, 1),
    callClaude(apiKey, imageBase64, mediaType, 2)
  ]);

  const vins = results.map(r => r ? sanitizeVin(r.vin) : '');
  const validVins = vins.filter(v => isValidVin(v));
  const finalVin = mergeVins(validVins);

  if (!finalVin) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: false, vin: '', confidence: 0,
        notes: 'VIN ვერ მოიძებნა. სცადეთ უფრო მკაფიო ფოტო.',
        wmi: '', vds: '', vis: '', location: ''
      })
    };
  }

  // confidence — რამდენი attempt-ი დაეთანხმა
  const agreements = validVins.filter(v => v === finalVin).length;
  const confidence = agreements === 3 ? 98 : agreements === 2 ? 82 : 65;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      found: true,
      vin: finalVin,
      confidence: confidence,
      wmi: finalVin.slice(0, 3),
      vds: finalVin.slice(3, 9),
      vis: finalVin.slice(9, 17),
      location: 'detected from image',
      notes: `3 სკანიდან ${agreements} დაეთანხმა. VINs: [${validVins.join(' | ')}]`
    })
  };
};
