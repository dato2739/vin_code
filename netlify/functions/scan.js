const https = require('https');

// ════════════════════════════════════════
// Claude-ის გამოძახება
// ════════════════════════════════════════
function callClaude(apiKey, imageBase64, mediaType, systemPrompt, userPrompt) {
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    temperature: 0,
    system: systemPrompt,
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

// ════════════════════════════════════════
// VIN ვალიდაცია
// ════════════════════════════════════════
function isValidVin(vin) {
  if (!vin || typeof vin !== 'string') return false;
  if (vin.length !== 17) return false;
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  return true;
}

// I→1, O→0, Q→0 ავტომატური კორექცია
function autoCorrect(vin) {
  return vin.toUpperCase()
    .replace(/I/g, '1')
    .replace(/O/g, '0')
    .replace(/Q/g, '0');
}

// ════════════════════════════════════════
// სიმბოლო-დონის კონფიდენსი
// შეადარე ორი შედეგი პოზიციაში
// ════════════════════════════════════════
function buildCharConfidence(vinA, vinB, charConfsA, charConfsB) {
  const result = [];
  for (let i = 0; i < 17; i++) {
    const cA = vinA[i];
    const cB = vinB[i];
    const confA = (charConfsA && charConfsA[i]) || 'MEDIUM';
    const confB = (charConfsB && charConfsB[i]) || 'MEDIUM';

    if (cA === cB) {
      // ორივე ეთანხმება
      const confScore = { HIGH: 2, MEDIUM: 1, LOW: 0 };
      const best = confScore[confA] >= confScore[confB] ? confA : confB;
      result.push({ c: cA, conf: best === 'LOW' ? 'MEDIUM' : 'HIGH' });
    } else {
      // არ ეთანხმება — LOW
      const confScore = { HIGH: 2, MEDIUM: 1, LOW: 0 };
      const winner = confScore[confA] >= confScore[confB] ? cA : cB;
      result.push({ c: winner, conf: 'LOW' });
    }
  }
  return result;
}

// ════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API გასაღები არ არის კონფიგურირებული.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { imageBase64, mediaType } = body;
  if (!imageBase64 || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: 'imageBase64 და mediaType საჭიროა.' }) };
  }

  // ════════════════════════════════════════
  // STEP 1: ორი სხვადასხვა prompt-ით კითხვა
  // temperature=0 → დეტერმინისტული პასუხი
  // ════════════════════════════════════════

  const SYSTEM = `You are a precise VIN decoder. You only output valid JSON. You never hallucinate characters. If you cannot clearly read a character, you mark it LOW confidence. VIN rules: exactly 17 chars, A-Z (no I,O,Q) and 0-9.`;

  const PROMPT_1 = `Find the VIN number in this image and read it character by character.

For each of the 17 characters, state:
- The character itself (A-Z no I/O/Q, or 0-9)
- Your confidence: HIGH (clearly visible), MEDIUM (likely correct), LOW (uncertain)

Output ONLY this JSON:
{
  "found": true,
  "vin": "all 17 chars joined",
  "chars": [{"c":"X","conf":"HIGH"}, ...]
}

If no VIN found: {"found": false, "vin": "", "chars": []}`;

  const PROMPT_2 = `Locate the Vehicle Identification Number (VIN) in this image.

Read each character with extreme care. Watch for these common mistakes:
- The digit 0 (zero) looks like letter O — in VINs it is ALWAYS 0
- The digit 1 (one) looks like letter I or L — in VINs it is ALWAYS 1
- The digit 2 can look like Z — look at the angles
- The digit 8 can look like B — count the enclosed areas
- The digit 5 can look like S — look at the top

For each of the 17 characters output your certainty:
HIGH = no doubt at all
MEDIUM = fairly sure but not 100%
LOW = genuinely uncertain

Output ONLY this JSON:
{
  "found": true,
  "vin": "all 17 chars joined",
  "chars": [{"c":"X","conf":"HIGH"}, ...]
}

If no VIN found: {"found": false, "vin": "", "chars": []}`;

  // პარალელური გამოძახება
  const [res1, res2] = await Promise.all([
    callClaude(apiKey, imageBase64, mediaType, SYSTEM, PROMPT_1),
    callClaude(apiKey, imageBase64, mediaType, SYSTEM, PROMPT_2)
  ]);

  // ════════════════════════════════════════
  // STEP 2: შედეგების გაწმენდა და ვალიდაცია
  // ════════════════════════════════════════
  function extractResult(r) {
    if (!r || !r.found || !r.vin) return null;
    const corrected = autoCorrect(r.vin.replace(/\s/g,''));
    if (!isValidVin(corrected)) return null;
    const chars = r.chars && r.chars.length === 17 ? r.chars : corrected.split('').map(c => ({c, conf:'MEDIUM'}));
    // chars-ზეც auto-correct
    const correctedChars = chars.map(ch => ({
      c: autoCorrect(ch.c || ''),
      conf: ch.conf || 'MEDIUM'
    }));
    return { vin: corrected, chars: correctedChars };
  }

  const v1 = extractResult(res1);
  const v2 = extractResult(res2);

  // ════════════════════════════════════════
  // STEP 3: შედეგების შეჯერება
  // ════════════════════════════════════════
  let finalVin, finalChars, matchStatus;

  if (!v1 && !v2) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: false, vin: '', chars: [], confidence: 0,
        wmi: '', vds: '', vis: '',
        notes: 'VIN ვერ მოიძებნა. სცადეთ უფრო მკაფიო ან ახლოდან გადაღებული ფოტო.'
      })
    };
  }

  if (v1 && v2) {
    if (v1.vin === v2.vin) {
      // სრული დამთხვევა
      finalVin = v1.vin;
      finalChars = buildCharConfidence(v1.vin, v2.vin, v1.chars.map(c=>c.conf), v2.chars.map(c=>c.conf));
      matchStatus = 'FULL_MATCH';
    } else {
      // ნაწილობრივი დამთხვევა — სიმბოლო-დონის შეჯერება
      finalChars = buildCharConfidence(v1.vin, v2.vin, v1.chars.map(c=>c.conf), v2.chars.map(c=>c.conf));
      finalVin = finalChars.map(c=>c.c).join('');
      matchStatus = 'PARTIAL_MATCH';
    }
  } else {
    // მხოლოდ ერთი მუშაობს
    const only = v1 || v2;
    finalVin = only.vin;
    finalChars = only.chars.map(ch => ({ c: ch.c, conf: ch.conf === 'HIGH' ? 'MEDIUM' : 'LOW' }));
    matchStatus = 'SINGLE_RESULT';
  }

  // საბოლოო ვალიდაცია
  if (!isValidVin(finalVin)) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: false, vin: '', chars: [], confidence: 0,
        wmi: '', vds: '', vis: '',
        notes: 'ამოღებული კოდი ვალიდური VIN არ არის.'
      })
    };
  }

  // confidence გამოთვლა
  const confScore = { HIGH: 2, MEDIUM: 1, LOW: 0 };
  const avgScore = finalChars.reduce((s, c) => s + (confScore[c.conf] || 0), 0) / 17;
  const matchBonus = matchStatus === 'FULL_MATCH' ? 15 : matchStatus === 'PARTIAL_MATCH' ? 0 : -10;
  const confidence = Math.min(99, Math.round(55 + avgScore * 20 + matchBonus));

  const v1str = v1 ? v1.vin : 'fail';
  const v2str = v2 ? v2.vin : 'fail';

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
      notes: `scan1: ${v1str} | scan2: ${v2str} | status: ${matchStatus}`
    })
  };
};
