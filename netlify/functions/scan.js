const https = require('https');

function callClaude(apiKey, imageBase64, mediaType) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageBase64 }
          },
          {
            type: 'text',
            text: 'What is the VIN number in this image? Read it exactly as printed. Return ONLY JSON: {"vin": "the 17 character VIN you see", "found": true} or {"vin": "", "found": false} if no VIN visible.'
          }
        ]
      },
      { role: 'assistant', content: '{"' }
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
          const raw = '{"' + p.content.map(b => b.text || '').join('');
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
    .replace(/I/g, '1').replace(/O/g, '0').replace(/Q/g, '0');
}

function valid(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

// CHECK DIGIT
const CV = {A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,0:0,1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9};
const CW = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];

function checkDigit(vin) {
  let s = 0;
  for (let i = 0; i < 17; i++) { const v = CV[vin[i]]; if (v===undefined) return null; s += v * CW[i]; }
  const r = s % 11; return r === 10 ? 'X' : String(r);
}

function checkValid(vin) { const cd = checkDigit(vin); return cd !== null && vin[8] === cd; }

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'API გასაღები არ არის.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { imageBase64, mediaType } = body;
  if (!imageBase64 || !mediaType) return { statusCode: 400, body: JSON.stringify({ error: 'imageBase64 და mediaType საჭიროა.' }) };

  // 3 სკანი პარალელურად
  const [r1, r2, r3] = await Promise.all([
    callClaude(apiKey, imageBase64, mediaType),
    callClaude(apiKey, imageBase64, mediaType),
    callClaude(apiKey, imageBase64, mediaType)
  ]);

  // ვალიდური VIN-ების ამოღება
  const vins = [r1, r2, r3]
    .map(r => r && r.found ? fix(r.vin) : '')
    .filter(v => valid(v));

  if (vins.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: false, vin: '', chars: [], confidence: 0,
        wmi: '', vds: '', vis: '',
        notes: 'VIN ვერ მოიძებნა. სცადეთ უფრო ახლოდან ან მკაფიო ფოტო.'
      })
    };
  }

  // majority vote სიმბოლო-დონეზე
  const finalChars = [];
  for (let i = 0; i < 17; i++) {
    const freq = {};
    vins.forEach(v => { freq[v[i]] = (freq[v[i]] || 0) + 1; });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const top = sorted[0];
    const conf = top[1] === vins.length ? 'HIGH' : top[1] > vins.length / 2 ? 'MEDIUM' : 'LOW';
    finalChars.push({ c: top[0], conf });
  }

  let finalVin = finalChars.map(c => c.c).join('');

  // check digit კორექცია
  if (!checkValid(finalVin)) {
    const chars = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';
    for (const c of chars) {
      const attempt = finalVin.slice(0, 8) + c + finalVin.slice(9);
      if (checkValid(attempt)) {
        finalVin = attempt;
        finalChars[8] = { c, conf: 'MEDIUM' };
        break;
      }
    }
  }

  const allMatch = vins.every(v => v === vins[0]);
  const majorityMatch = vins.filter(v => v === finalVin).length >= 2;
  const matchStatus = allMatch ? 'FULL_MATCH' : majorityMatch ? 'MAJORITY_MATCH' : 'PARTIAL_MATCH';

  const scoreMap = { HIGH: 2, MEDIUM: 1, LOW: 0 };
  const avg = finalChars.reduce((s, c) => s + (scoreMap[c.conf] || 0), 0) / 17;
  const bonus = allMatch ? 20 : majorityMatch ? 10 : 0;
  const cdBonus = checkValid(finalVin) ? 10 : -10;
  const confidence = Math.min(99, Math.round(50 + avg * 20 + bonus + cdBonus));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      found: true,
      vin: finalVin,
      chars: finalChars,
      confidence,
      wmi: finalVin.slice(0, 3),
      vds: finalVin.slice(3, 9),
      vis: finalVin.slice(9, 17),
      matchStatus,
      checkDigitValid: checkValid(finalVin),
      notes: 'scans: [' + vins.join(' | ') + '] | ' + matchStatus
    })
  };
};
