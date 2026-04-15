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
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

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
          text: 'Extract the vehicle VIN number from this image.\nReturn ONLY valid JSON, no markdown:\n{\n  "found": true or false,\n  "vin": "17-char VIN or empty string",\n  "confidence": 0-100,\n  "location": "where in image the VIN was found",\n  "wmi": "chars 1-3",\n  "vds": "chars 4-9",\n  "vis": "chars 10-17",\n  "notes": "short note"\n}\nRules: VIN = 17 chars, only A-Z (no I/O/Q) and 0-9.'
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
