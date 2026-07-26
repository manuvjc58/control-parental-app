const express = require('express');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const devices = new Map();
const commandHistory = new Map();

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
        channelId: 'commands',
      }),
    });
    const result = await response.json();
    console.log('Push enviada:', result);
    return result;
  } catch (error) {
    console.error('Error enviando push:', error);
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
    deviceId,
    pushToken,
    platform,
    manufacturer,
    modelName,
    osName,
    osVersion,
    registeredAt: Date.now(),
    lastSeen: Date.now()
  });

  console.log('Dispositivo registrado:', deviceId, manufacturer, modelName);
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
      targetDevice.pushToken,
      'Comando Remoto',
      `Ejecutando: ${command.type}`,
      { type: 'command', command, action: 'execute' }
    );

    if (!commandHistory.has(targetDevice.deviceId)) {
      commandHistory.set(targetDevice.deviceId, []);
    }
    commandHistory.get(targetDevice.deviceId).push({
      command,
      timestamp: Date.now(),
      status: 'sent',
      pushResult: result
    });

    res.json({ success: true, message: 'Comando enviado via push', pushResult: result });
  } else {
    res.status(404).json({ success: false, message: 'Dispositivo no encontrado o sin token push' });
  }
});

app.get('/api/check-child', (req, res) => {
  if (devices.size > 0) {
    const device = devices.values().next().value;
    device.lastSeen = Date.now();
    res.json({
      connected: true,
      device: {
        deviceId: device.deviceId,
        pushToken: device.pushToken,
        manufacturer: device.manufacturer,
        modelName: device.modelName,
        osName: device.osName,
        osVersion: device.osVersion,
        lastSeen: device.lastSeen
      }
    });
  } else {
    res.json({ connected: false, device: null });
  }
});

app.post('/api/send-to-parent', (req, res) => {
  const { event, data, deviceId, timestamp } = req.body;
  console.log('Evento del hijo:', event, data);

  const device = devices.get(deviceId);
  if (device) {
    device.lastSeen = Date.now();
  }

  res.json({ success: true });
});

app.get('/api/device-status/:deviceId', (req, res) => {
  const device = devices.get(req.params.deviceId);
  if (device) {
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
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
