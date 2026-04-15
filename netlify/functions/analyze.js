const https = require('https');

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

  const prompt = `გაანალიზე ეს მანქანის VIN კოდი: ${vin}

დააბრუნე მხოლოდ JSON ობიექტი, markdown გარეშე:
{
  "summary": "2-3 წინადადება ამ მანქანის შესახებ ქართულად",
  "specs": {
    "მწარმოებელი": "...",
    "ქვეყანა": "...",
    "მოდელის წელი": "...",
    "მოდელი/სერია": "...",
    "ძრავი": "...",
    "კუზოვის ტიპი": "..."
  },
  "vinBreakdown": {
    "WMI (${vin.slice(0,3)})": "მწარმოებლის კოდის განმარტება",
    "VDS (${vin.slice(3,9)})": "მანქანის მახასიათებლების განმარტება",
    "VIS (${vin.slice(9)})": "სერიული ნომრის განმარტება"
  },
  "tips": [
    "პირველი რჩევა ამ მანქანის შეძენამდე",
    "მეორე რჩევა",
    "მესამე რჩევა"
  ]
}`;

  const claudeBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  const resp = await httpsPost({
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

  if (resp.status !== 200 || !resp.data?.content) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Claude API შეცდომა: ' + (resp.data?.error?.message || resp.status) })
    };
  }

  try {
    const raw = resp.data.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'პასუხის დამუშავების შეცდომა.' })
    };
  }
};
