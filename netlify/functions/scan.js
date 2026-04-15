const https = require('https');

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

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
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
            text: 'You are a VIN reading specialist. Your ONLY job is to find and read the VIN number exactly as printed in this image.\n\nSTRICT RULES:\n1. SCAN the entire image carefully for any 17-character alphanumeric string\n2. VIN uses digits 0-9 and letters A-Z — but letters I, O, Q are NEVER used in VINs\n3. READ printed text ONLY — do NOT decode barcodes\n4. COPY each character EXACTLY as you see it printed\n5. A VIN is always EXACTLY 17 characters\n6. If you see something that looks like the letter O but is in a VIN context, it is the digit 0\n7. DOUBLE-CHECK: count your answer — must be exactly 17 characters\n8. If you cannot clearly read the VIN, set found=false\n\nReturn ONLY this JSON (no markdown):\n{\n  "found": true or false,\n  "vin": "exactly 17 characters as seen in image, or empty string",\n  "confidence": 0-100,\n  "location": "where in the image",\n  "wmi": "characters 1-3",\n  "vds": "characters 4-9",\n  "vis": "characters 10-17",\n  "notes": "what text you see near the VIN"\n}'
          }
        ]
      },
      {
        role: 'assistant',
        content: '{"found":'
      }
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
          if (res.statusCode !== 200) {
            resolve({
              statusCode: res.statusCode,
              body: JSON.stringify({ error: parsed.error?.message || 'API შეცდომა: ' + res.statusCode })
            });
            return;
          }

          const raw = '{"found":' + parsed.content.map(b => b.text || '').join('');
          const clean = raw.replace(/```json|```/g, '').trim();
          const result = JSON.parse(clean);

          // auto-correct + validate
          if (result.found && result.vin) {
            let vin = result.vin.toUpperCase().replace(/I/g, '1').replace(/O/g, '0').replace(/Q/g, '0');

            if (vin !== result.vin) {
              result.notes = (result.notes || '') + ' [auto-corrected I/O/Q]';
            }

            if (vin.length !== 17 || !/^[A-Z0-9]{17}$/.test(vin)) {
              result.found = false;
              result.vin = '';
              result.notes = (result.notes || '') + ' [validation failed: length=' + vin.length + ']';
            } else {
              result.vin = vin;
              result.wmi = vin.slice(0, 3);
              result.vds = vin.slice(3, 9);
              result.vis = vin.slice(9, 17);
            }
          }

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
