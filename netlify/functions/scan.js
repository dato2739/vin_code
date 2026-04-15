const https = require('https');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'API გასაღები კონფიგურირებული არ არის სერვერზე.' })
    };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { imageBase64, mediaType } = body;
  if (!imageBase64 || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: 'imageBase64 და mediaType საჭიროა.' }) };
  }

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: imageBase64 }
        },
        {
          type: 'text',
          text: `Look carefully at this image and find the VIN (Vehicle Identification Number).

IMPORTANT RULES:
- Read the EXACT characters visible in the image — do NOT guess or infer
- A VIN is exactly 17 characters: digits 0-9 and letters A-Z (never I, O, or Q)
- Look for text labeled "VIN", "V.I.N", or a standalone 17-character alphanumeric string
- If you see a barcode, look for the text printed near or below it
- Do NOT read barcodes — read only printed text characters
- Copy each character exactly as printed, one by one

Return ONLY valid JSON, no markdown:
{
  "found": true or false,
  "vin": "exact 17-char VIN copied from image, or empty string",
  "confidence": 0-100,
  "location": "exactly where in the image you found it",
  "wmi": "first 3 chars",
  "vds": "chars 4-9",
  "vis": "chars 10-17",
  "notes": "what you literally see printed near the VIN"
}`
        }
      ]
    }]
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
          if (res.statusCode !== 200) {
            resolve({
              statusCode: res.statusCode,
              body: JSON.stringify({ error: parsed.error?.message || 'API შეცდომა' })
            });
            return;
          }
          const raw = parsed.content.map(b => b.text || '').join('');
          const clean = raw.replace(/```json|```/g, '').trim();
          const result = JSON.parse(clean);
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result)
          });
        } catch (err) {
          resolve({
            statusCode: 500,
            body: JSON.stringify({ error: 'პასუხის შეცდომა: ' + err.message })
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 500,
        body: JSON.stringify({ error: 'კავშირის შეცდომა: ' + err.message })
      });
    });

    req.write(requestBody);
    req.end();
  });
};
