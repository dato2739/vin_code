const https = require('https');

// ══════════════════════════════════════
// CHECK DIGIT (პოზიცია 9, index 8)
// ══════════════════════════════════════
const CHAR_VALS = {
  A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,
  J:1,K:2,L:3,M:4,N:5,P:7,R:9,
  S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,
  0:0,1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9
};
const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];

function getCheckDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = CHAR_VALS[vin[i]];
    if (v === undefined) return null;
    sum += v * WEIGHTS[i];
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

function checkDigitValid(vin) {
  const cd = getCheckDigit(vin);
  return cd !== null && vin[8] === cd;
}

// ══════════════════════════════════════
// UTILS
// ══════════════════════════════════════
function fixVin(raw) {
  return (raw || '').toUpperCase().replace(/\s/g,'')
    .replace(/I/g,'1').replace(/O/g,'0').replace(/Q/g,'0');
}

function isValid(vin) {
  return typeof vin === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

// ══════════════════════════════════════
// CLAUDE CALL
// ══════════════════════════════════════
function callClaude(apiKey, imageBase64, mediaType, prompt) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 700,
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
          const raw = '{"found":' + p.content.map(b => b.text||'').join('');
          resolve(JSON.parse(raw.replace(/```json|```/g,'').trim()));
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════
// MAJORITY VOTE — სიმბოლო-დონეზე
// ══════════════════════════════════════
function majorityVote(vins) {
  // vins = ['ABC...', 'ABC...', 'ABD...']
  const result = [];
  for (let i = 0; i < 17; i++) {
    const freq = {};
    for (const v of vins) {
      const c = v[i];
      freq[c] = (freq[c] || 0) + 1;
    }
    // ყველაზე ხშირი სიმბოლო
    const sorted = Object.entries(freq).sort((a,b) => b[1]-a[1]);
    const top = sorted[0];
    const count = top[1];
    const total = vins.length;
    // conf: ყველა ეთანხმება=HIGH, უმრავლესობა=MEDIUM, ნახევარი=LOW
    const conf = count === total ? 'HIGH' : count > total/2 ? 'MEDIUM' : 'LOW';
    result.push({ c: top[0], conf });
  }
  return result;
}

// ══════════════════════════════════════
// MAIN
// ══════════════════════════════════════
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'API გასაღები არ არის.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { imageBase64, mediaType } = body;
  if (!imageBase64 || !mediaType) return { statusCode: 400, body: JSON.stringify({ error: 'imageBase64 და mediaType საჭიროა.' }) };

  const PROMPT = `Find the VIN (Vehicle Identification Number) in this image.

The VIN is a 17-character code printed on a label, plate, or sticker. It may be on a windshield, door jamb, or chassis. Dark background and glass reflections are normal — focus on reading the text.

Read each character exactly as you see it printed. Output each character and your confidence:
- HIGH: clearly visible, no doubt
- MEDIUM: visible but slightly unclear
- LOW: hard to read, uncertain

Important rules:
- Never use letter I (write 1 instead)
- Never use letter O (write 0 instead)  
- Never use letter Q (write 0 instead)
- VIN is exactly 17 characters

Return ONLY this JSON (nothing else):
{"found":true,"vin":"17chars","chars":[{"c":"J","conf":"HIGH"},{"c":"M","conf":"HIGH"},...17 total]}

If you cannot find a VIN: {"found":false,"vin":"","chars":[]}`;

  // 3 პარალელური სკანი
  const [r1, r2, r3] = await Promise.all([
    callClaude(apiKey, imageBase64, mediaType, PROMPT),
    callClaude(apiKey, imageBase64, mediaType, PROMPT),
    callClaude(apiKey, imageBase64, mediaType, PROMPT)
  ]);

  // ამოიღე ვალიდური VIN-ები
  function extract(r) {
    if (!r || !r.found || !r.vin) return null;
    const vin = fixVin(r.vin);
    if (!isValid(vin)) return null;
    const chars = (r.chars && r.chars.length === 17)
      ? r.chars.map(ch => ({ c: fixVin(ch.c||'?')[0]||'?', conf: ch.conf||'MEDIUM' }))
      : vin.split('').map(c => ({ c, conf: 'MEDIUM' }));
    return { vin, chars };
  }

  const results = [r1, r2, r3].map(extract).filter(Boolean);

  if (results.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: false, vin: '', chars: [], confidence: 0,
        wmi:'', vds:'', vis:'',
        notes: 'VIN ვერ მოიძებნა. სცადეთ: ახლოდან გადაიღეთ / კარგი განათება / VIN კარგად მოხვდეს კადრში.'
      })
    };
  }

  const vins = results.map(r => r.vin);
  const confs = results.map(r => r.chars.map(c => c.conf));

  // majority vote სიმბოლო-დონეზე
  let finalChars = majorityVote(vins);
  let finalVin = finalChars.map(c => c.c).join('');

  // check digit ვალიდაცია
  const cdValid = checkDigitValid(finalVin);
  let cdFixed = false;

  if (!cdValid) {
    // სცადე check digit-ის ავტომატური კორექცია
    const CHARS = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';
    for (const c of CHARS) {
      const attempt = finalVin.slice(0,8) + c + finalVin.slice(9);
      if (checkDigitValid(attempt)) {
        finalVin = attempt;
        finalChars[8] = { c, conf: 'MEDIUM' };
        cdFixed = true;
        break;
      }
    }
  }

  // match სტატუსი
  const allMatch = vins.every(v => v === vins[0]);
  const matchCount = vins.filter(v => v === finalVin).length;
  const matchStatus = allMatch ? 'FULL_MATCH' :
    matchCount >= 2 ? 'MAJORITY_MATCH' : 'PARTIAL_MATCH';

  // confidence
  const scoreMap = { HIGH: 2, MEDIUM: 1, LOW: 0 };
  const avg = finalChars.reduce((s,c) => s + (scoreMap[c.conf]||0), 0) / 17;
  const matchBonus = allMatch ? 20 : matchCount >= 2 ? 10 : 0;
  const cdBonus = checkDigitValid(finalVin) ? 10 : -15;
  const confidence = Math.min(99, Math.round(50 + avg * 20 + matchBonus + cdBonus));

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
      checkDigitValid: checkDigitValid(finalVin),
      notes: `scans: [${vins.join(' | ')}] | ${matchStatus} | check:${checkDigitValid(finalVin)?'✓':'✗'}${cdFixed?' (auto-fixed)':''}`
    })
  };
};
