const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'audio/*', limit: '50mb' }));

const PORT = process.env.PORT || 3000;

const devices = new Map();
const commandHistory = new Map();
const recordings = new Map();

const AUDIO_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

async function sendExpoPushNotification(pushToken, title, body, data = {}) {
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: pushToken,
        title,
        body,
        data,
        sound: 'default',
        priority: 'high',
      }),
    });
    const result = await response.json();
    console.log('Push result:', result);
    return result;
  } catch (error) {
    console.error('Push error:', error);
    return null;
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connectedDevices: devices.size
  });
});

app.post('/api/register-device', (req, res) => {
  const { deviceId, pushToken, platform, manufacturer, modelName, osName, osVersion } = req.body;
  devices.set(deviceId, {
    deviceId, pushToken, platform, manufacturer, modelName, osName, osVersion,
    registeredAt: Date.now(), lastSeen: Date.now()
  });
  console.log('Device registered:', deviceId, manufacturer, modelName);
  res.json({ success: true, deviceId });
});

app.post('/api/send-command', async (req, res) => {
  const { command, deviceId } = req.body;
  let targetDevice = devices.get(deviceId);
  if (!targetDevice && devices.size > 0) {
    targetDevice = devices.values().next().value;
  }
  if (targetDevice && targetDevice.pushToken) {
    const result = await sendExpoPushNotification(
      targetDevice.pushToken, 'Comando Remoto',
      `Ejecutando: ${command.type}`,
      { type: 'command', command, action: 'execute' }
    );
    if (!commandHistory.has(targetDevice.deviceId)) {
      commandHistory.set(targetDevice.deviceId, []);
    }
    commandHistory.get(targetDevice.deviceId).push({
      command, timestamp: Date.now(), status: 'sent', pushResult: result
    });
    res.json({ success: true, message: 'Comando enviado via push' });
  } else {
    res.status(404).json({ success: false, message: 'Dispositivo no encontrado' });
  }
});

app.get('/api/check-child', (req, res) => {
  if (devices.size > 0) {
    const device = devices.values().next().value;
    res.json({
      connected: true,
      device: {
        deviceId: device.deviceId, pushToken: device.pushToken,
        manufacturer: device.manufacturer, modelName: device.modelName,
        osName: device.osName, osVersion: device.osVersion, lastSeen: device.lastSeen
      }
    });
  } else {
    res.json({ connected: false, device: null });
  }
});

app.post('/api/send-to-parent', (req, res) => {
  const { event, data, deviceId, timestamp } = req.body;
  console.log('Child event:', event, data);
  res.json({ success: true });
});

app.post('/api/upload-audio', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  try {
    const deviceId = req.query.deviceId || 'unknown';
    const timestamp = Date.now();
    const filename = `${deviceId}_${timestamp}.wav`;
    const filepath = path.join(AUDIO_DIR, filename);

    fs.writeFileSync(filepath, req.body);

    if (!recordings.has(deviceId)) {
      recordings.set(deviceId, []);
    }
    recordings.get(deviceId).push({ filename, timestamp, size: req.body.length });

    console.log(`Audio guardado: ${filename} (${req.body.length} bytes)`);
    res.json({ success: true, filename, size: req.body.length });
  } catch (error) {
    console.error('Error guardando audio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/recordings/:deviceId', (req, res) => {
  const recs = recordings.get(req.params.deviceId) || [];
  res.json({ recordings: recs.reverse() });
});

app.get('/api/audio/:deviceId/:filename', (req, res) => {
  const filepath = path.join(AUDIO_DIR, req.params.filename);
  if (fs.existsSync(filepath)) {
    res.set('Content-Type', 'audio/wav');
    fs.createReadStream(filepath).pipe(res);
  } else {
    res.status(404).json({ error: 'Audio no encontrado' });
  }
});

app.get('/api/device-status/:deviceId', (req, res) => {
  const device = devices.get(req.params.deviceId);
  if (device) {
    device.lastSeen = Date.now();
    res.json({ online: true, lastSeen: device.lastSeen, info: device });
  } else {
    res.json({ online: false });
  }
});

app.get('/api/command-history/:deviceId', (req, res) => {
  const history = commandHistory.get(req.params.deviceId) || [];
  res.json({ history });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
