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

// სიმბოლო-დონის კონფიდენსის რიცხვი 0-10
function charScore(conf) {
  return conf === 'HIGH' ? 10 : conf === 'MEDIUM' ? 5 : 1;
}

// ვინ კოდის სიზუსტე 0-100
function calcVinScore(chars) {
  if (!chars || chars.length !== 17) return 0;
  return Math.round(chars.reduce((s, c) => s + charScore(c.conf), 0) / 17 * 10);
}

function buildCharConfidence(v1, v2, c1, c2) {
  const result = [];
  for (let i = 0; i < 17; i++) {
    const s1 = charScore(c1[i]);
    const s2 = charScore(c2[i]);
    if (v1[i] === v2[i]) {
      // ეთანხმება — HIGH
      result.push({ c: v1[i], conf: 'HIGH' });
    } else {
      // არ ეთანხმება — LOW, უფრო დარწმუნებული სიმბოლო
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

  const PROMPT_1 = `You are reading a VIN from a vehicle image.

CRITICAL RULE: If the image is blurry, dark, rotated, or the VIN text is not clearly legible — you MUST return found=false. Do NOT guess. Do NOT hallucinate characters.

Only proceed if you can CLEARLY see printed alphanumeric characters in the image that form a 17-character VIN.

Steps:
1. Is the VIN text clearly visible and legible in this image? If NO → return found=false immediately.
2. If YES → read each character one by one from the image.
3. For each character rate confidence:
   - HIGH: I can clearly see and read this character, no doubt
   - MEDIUM: I can see it but it's slightly unclear
   - LOW: I am guessing — the image is unclear here

Rules:
- Never use letter I (→ digit 1), never letter O (→ digit 0), never Q (→ digit 0)
- If more than 4 characters are LOW confidence → return found=false (image too unclear)
- Do NOT use training data or memory — only read what you see

Return ONLY JSON:
{
  "found": true or false,
  "image_quality": "GOOD" or "POOR" or "UNREADABLE",
  "vin": "17 chars or empty string",
  "chars": [{"c":"X","conf":"HIGH"}, ... 17 entries if found],
  "reason": "why found=false if applicable"
}`;

  const PROMPT_2 = `Examine this image carefully.

FIRST: Assess the image quality for VIN reading:
- Can you clearly see a label, sticker or plate with alphanumeric text?
- Is the text sharp and in focus?
- If the answer to either question is NO → immediately return found=false

ONLY IF the VIN is clearly visible and readable:
- Read each of the 17 characters exactly as printed
- Never guess — if a character is unclear, mark it LOW
- If 4 or more characters are unclear → return found=false
- Replace any O with 0, any I with 1, any Q with 0

Common confusions: 0 vs D, 1 vs L, 8 vs B, 6 vs G, 2 vs Z, 5 vs S

Return ONLY JSON:
{
  "found": true or false,
  "image_quality": "GOOD" or "POOR" or "UNREADABLE",
  "vin": "17 chars or empty string",
  "chars": [{"c":"X","conf":"HIGH"}, ... 17 entries if found],
  "reason": "explanation if found=false"
}`;

  const [res1, res2] = await Promise.all([
    callClaude(apiKey, imageBase64, mediaType, PROMPT_1),
    callClaude(apiKey, imageBase64, mediaType, PROMPT_2)
  ]);

  function extract(r) {
    if (!r || !r.found || !r.vin) return null;
    // სურათი ბუნდოვანია
    if (r.image_quality === 'UNREADABLE' || r.image_quality === 'POOR') return null;
    const vin = autoCorrect(r.vin);
    if (!isValidVin(vin)) return null;
    const chars = (r.chars && r.chars.length === 17)
      ? r.chars.map(ch => ({ c: autoCorrect(ch.c || '?'), conf: ch.conf || 'LOW' }))
      : vin.split('').map(c => ({ c, conf: 'MEDIUM' }));
    // 4+ LOW სიმბოლო → უარი
    const lowCount = chars.filter(c => c.conf === 'LOW').length;
    if (lowCount >= 4) return null;
    const score = calcVinScore(chars);
    return { vin, chars, score };
  }

  const v1 = extract(res1);
  const v2 = extract(res2);

  // ══════════════════════════════════
  // ვერ წაიკითხა — მკაფიო შეტყობინება
  // ══════════════════════════════════
  if (!v1 && !v2) {
    const quality1 = res1?.image_quality || 'UNREADABLE';
    const quality2 = res2?.image_quality || 'UNREADABLE';
    const reason = res1?.reason || res2?.reason || '';
    let msg = 'VIN ვერ წაიკითხა.';
    if (quality1 === 'POOR' || quality2 === 'POOR' || quality1 === 'UNREADABLE') {
      msg = 'სურათი ბუნდოვანია — VIN ტექსტი კარგად არ ჩანს. გთხოვთ:\n• ახლოდან გადაიღეთ\n• კარგი განათებით\n• კამერა დააფიქსირეთ (ბუნება)';
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: false, vin: '', chars: [], confidence: 0, wmi:'', vds:'', vis:'', notes: msg })
    };
  }

  // ══════════════════════════════════
  // შედეგების შეჯერება
  // ══════════════════════════════════
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
      // PARTIAL_MATCH-ზე 3+ LOW → უარი
      const lowCount = finalChars.filter(c=>c.conf==='LOW').length;
      if (lowCount >= 3) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            found: false, vin: '', chars: [], confidence: 0, wmi:'', vds:'', vis:'',
            notes: 'ორი სკანი განსხვავებულ შედეგს იძლევა — სურათი არ არის საკმარისად მკაფიო. გთხოვთ უფრო ახლოდან გადაიღოთ.'
          })
        };
      }
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

  // confidence
  const avgScore = finalChars.reduce((s,c) => s + charScore(c.conf), 0) / 17;
  const bonus = matchStatus === 'FULL_MATCH' ? 15 : matchStatus === 'PARTIAL_MATCH' ? 0 : -10;
  const confidence = Math.min(99, Math.round(55 + avgScore * 4 + bonus));

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
