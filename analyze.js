const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

function httpsPost(options, body) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', (e) => resolve({ status: 500, data: null }));
    req.write(body);
    req.end();
  });
}

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
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { vin } = body;
  if (!vin || vin.length !== 17) {
    return { statusCode: 400, body: JSON.stringify({ error: 'სწორი 17-სიმბოლოიანი VIN საჭიროა.' }) };
  }

  // ── 1. NHTSA მონაცემები ──
  let nhtsaData = null;
  let recallData = null;
  try {
    nhtsaData = await httpsGet(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`);
    recallData = await httpsGet(`https://api.nhtsa.gov/recalls/recallsByVehicle?vin=${vin}`);
  } catch(e) {}

  const nhtsa = nhtsaData?.Results?.[0] || {};
  const recalls = recallData?.results || [];

  const nhtsaSummary = {
    make: nhtsa.Make || '',
    model: nhtsa.Model || '',
    year: nhtsa.ModelYear || '',
    trim: nhtsa.Trim || '',
    bodyClass: nhtsa.BodyClass || '',
    engineCC: nhtsa.DisplacementCC || '',
    engineCyl: nhtsa.EngineCylinders || '',
    fuelType: nhtsa.FuelTypePrimary || '',
    driveType: nhtsa.DriveType || '',
    transmission: nhtsa.TransmissionStyle || '',
    country: nhtsa.PlantCountry || '',
    manufacturer: nhtsa.Manufacturer || '',
    vehicleType: nhtsa.VehicleType || '',
    recallCount: recalls.length,
    recalls: recalls.slice(0, 3).map(r => r.Component || r.Summary || '')
  };

  // ── 2. Claude ანალიზი ──
  const prompt = `You are a vehicle expert. Analyze this VIN: ${vin}

NHTSA data:
- Make: ${nhtsaSummary.make}
- Model: ${nhtsaSummary.model}
- Year: ${nhtsaSummary.year}
- Trim: ${nhtsaSummary.trim}
- Body: ${nhtsaSummary.bodyClass}
- Engine: ${nhtsaSummary.engineCyl} cyl, ${nhtsaSummary.engineCC}cc
- Fuel: ${nhtsaSummary.fuelType}
- Drive: ${nhtsaSummary.driveType}
- Transmission: ${nhtsaSummary.transmission}
- Country: ${nhtsaSummary.country}
- Manufacturer: ${nhtsaSummary.manufacturer}
- Recalls: ${nhtsaSummary.recallCount}

Respond ONLY in Georgian language with a JSON object, no markdown:
{
  "summary": "2-3 sentence overview of this vehicle in Georgian",
  "specs": {
    "მწარმოებელი": "...",
    "მოდელი": "...",
    "წელი": "...",
    "კუზოვი": "...",
    "ძრავი": "...",
    "საწვავი": "...",
    "წამყვანი": "...",
    "გადაცემათა კოლოფი": "...",
    "ქვეყანა": "..."
  },
  "vinBreakdown": {
    "WMI (1-3)": "explanation in Georgian",
    "VDS (4-9)": "explanation in Georgian",
    "VIS (10-17)": "explanation in Georgian"
  },
  "recallNote": "${nhtsaSummary.recallCount > 0 ? `${nhtsaSummary.recallCount} recall ნაპოვნია` : 'Recall არ ნაპოვნია'}",
  "buyerTips": ["tip1 in Georgian", "tip2 in Georgian", "tip3 in Georgian"]
}`;

  const claudeBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  const claudeResp = await httpsPost({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(claudeBody)
    }
  }, claudeBody);

  let claudeResult = null;
  if (claudeResp.status === 200 && claudeResp.data?.content) {
    try {
      const raw = claudeResp.data.content.map(b => b.text || '').join('');
      const clean = raw.replace(/```json|```/g, '').trim();
      claudeResult = JSON.parse(clean);
    } catch(e) {}
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vin,
      nhtsa: nhtsaSummary,
      analysis: claudeResult
    })
  };
};
