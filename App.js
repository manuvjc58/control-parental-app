import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, SafeAreaView, FlatList, Image,
  Alert, ScrollView, TextInput, Platform, Switch, Dimensions, Modal
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Audio } from 'expo-av';
import { Camera } from 'expo-camera';
import { io } from 'socket.io-client';

const SERVER_URL = 'https://control-parental-server-production.up.railway.app';
const { width: SCREEN_WIDTH } = Dimensions.get('window');

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false,
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
    if (finalStatus !== 'granted') return null;
    token = (await Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig.extra.eas.projectId })).data;
  }
  return token;
}

export default function App() {
  const [screen, setScreen] = useState('loading');
  const [mode, setMode] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [pushToken, setPushToken] = useState(null);
  const [childDeviceId, setChildDeviceId] = useState('child');
  const [childInfo, setChildInfo] = useState(null);
  const [secretCode, setSecretCode] = useState('');
  const [history, setHistory] = useState([]);
  const [isLiveListening, setIsLiveListening] = useState(false);
  const [isLiveReceiving, setIsLiveReceiving] = useState(false);
  const [liveChunksReceived, setLiveChunksReceived] = useState(0);
  const [lastCommand, setLastCommand] = useState(null);
  const [commandResults, setCommandResults] = useState([]);
  const [locationHistory, setLocationHistory] = useState([]);
  const [geofences, setGeofences] = useState([]);
  const [downtimeSchedule, setDowntimeSchedule] = useState({ enabled: false, startHour: 22, endHour: 7 });
  const [blockedApps, setBlockedApps] = useState([]);
  const [screenTimeLimit, setScreenTimeLimit] = useState(120);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [photos, setPhotos] = useState([]);
  const [sosActive, setSosActive] = useState(false);
  const [todayUsage, setTodayUsage] = useState({ screenTime: 0, notifications: 0, dataUsed: 0 });
  const [settingsTab, setSettingsTab] = useState('main');
  const [isLiveCamera, setIsLiveCamera] = useState(false);
  const [liveCameraFrame, setLiveCameraFrame] = useState(null);
  const [liveCameraModal, setLiveCameraModal] = useState(false);
  const [cameraFacing, setCameraFacing] = useState(Camera.Constants?.Type?.front || 'front');
  const socketRef = useRef(null);
  const cameraRef = useRef(null);
  const recordingRef = useRef(null);
  const soundRef = useRef(null);
  const chunkIndexRef = useRef(0);
  const isRecordingRef = useRef(false);
  const liveCameraIntervalRef = useRef(null);
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
      trackUsage();
    } else if (mode === 'padre') {
      checkServer();
      connectSocket('parent');
      const interval = setInterval(checkServer, 10000);
      return () => clearInterval(interval);
    }
    return () => cleanupSocket();
  }, [mode]);

  const cleanupSocket = () => {
    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
    stopLiveRecording();
  };

  const connectSocket = (role) => {
    if (socketRef.current) socketRef.current.disconnect();
    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 2000,
    });
    socket.on('connect', () => {
      socket.emit('register', { deviceId: childDeviceId, role });
      if (role === 'parent') socket.emit('join-parent', { deviceId: childDeviceId });
    });
    socket.on('command', (data) => { if (data.command) executeChildCommand(data.command); });
    socket.on('live-audio', (data) => { if (role === 'parent' && data.chunk) playAudioChunk(data.chunk, data.chunkIndex); });
    socket.on('chat-message', (data) => {
      setChatMessages(prev => [...prev, { text: data.text, from: data.from, time: new Date(data.timestamp).toLocaleTimeString() }].slice(-50));
    });
    socket.on('photo-taken', (data) => {
      if (role === 'parent' && data.photoUrl) {
        setPhotos(prev => [{ url: data.photoUrl, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 20));
        Alert.alert('Foto capturada', 'Se tomo una foto remotamente');
      }
    });
    socket.on('live-camera-frame', (data) => {
      if (role === 'parent' && data.frame) {
        setLiveCameraFrame(`data:image/jpeg;base64,${data.frame}`);
      }
    });
    socket.on('sos-alert', (data) => {
      if (role === 'parent') {
        Alert.alert('SOS', `El hijo necesita ayuda!\nUbicacion: ${data.latitude || 'N/A'}, ${data.longitude || 'N/A'}`);
      }
    });
    socket.on('geofence-alert', (data) => {
      if (role === 'parent') {
        Alert.alert('Geofence', data.message);
      }
    });
    socketRef.current = socket;
  };

  const loadSavedMode = async () => {
    try {
      const savedMode = await AsyncStorage.getItem('appMode');
      const savedDeviceId = await AsyncStorage.getItem('deviceId');
      if (savedDeviceId) setChildDeviceId(savedDeviceId);
      if (savedMode) { setMode(savedMode); setScreen(savedMode); }
      else setScreen('menu');
    } catch (e) { setScreen('menu'); }
  };

  const setupNotifications = () => {
    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      const data = notification.request.content.data;
      if (data && data.command && mode === 'hijo') executeChildCommand(data.command);
    });
    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data;
      if (data && data.action === 'open-parent') { setMode('padre'); setScreen('padre'); AsyncStorage.setItem('appMode', 'padre'); }
    });
  };

  const registerChildDevice = async () => {
    try {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        setPushToken(token);
        let deviceId = await AsyncStorage.getItem('deviceId');
        if (!deviceId) { deviceId = 'child_' + Math.random().toString(36).substr(2, 9); await AsyncStorage.setItem('deviceId', deviceId); }
        setChildDeviceId(deviceId);
        await fetch(`${SERVER_URL}/api/register-device`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId, pushToken: token, platform: Platform.OS,
            manufacturer: Device.manufacturer || 'unknown', modelName: Device.modelName || 'unknown',
            osName: Device.osName || 'unknown', osVersion: Device.osVersion || 'unknown'
          })
        });
        setIsConnected(true);
      }
    } catch (e) { console.log('Error registering:', e); }
  };

  const checkServer = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/health`);
      const data = await res.json();
      setIsConnected(data.status === 'ok');
      const deviceRes = await fetch(`${SERVER_URL}/api/check-child`);
      const deviceData = await deviceRes.json();
      if (deviceData.connected) setChildInfo(deviceData.device);
    } catch (e) { setIsConnected(false); }
  };

  const trackUsage = async () => {
    const saved = await AsyncStorage.getItem('todayUsage');
    if (saved) {
      const usage = JSON.parse(saved);
      const today = new Date().toDateString();
      if (usage.date === today) { setTodayUsage(usage); return; }
    }
    const usage = { date: new Date().toDateString(), screenTime: 0, notifications: 0, dataUsed: 0 };
    await AsyncStorage.setItem('todayUsage', JSON.stringify(usage));
    setTodayUsage(usage);
  };

  const sendCommandToChild = async (commandType, params = {}) => {
    const command = { type: commandType, ...params, timestamp: Date.now() };
    try {
      const res = await fetch(`${SERVER_URL}/api/send-command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, deviceId: childDeviceId || 'child' })
      });
      const data = await res.json();
      if (data.success) {
        setHistory(prev => [{ cmd: commandType, time: new Date().toLocaleTimeString(), status: 'sent' }, ...prev].slice(0, 50));
        if (commandType === 'listen-live') { setIsLiveReceiving(true); setLiveChunksReceived(0); chunkIndexRef.current = 0; }
        else if (commandType === 'stop-listen-live') setIsLiveReceiving(false);
        else if (commandType !== 'send-notification') Alert.alert('Comando enviado', commandType);
      } else Alert.alert('Error', data.message || 'No se pudo enviar');
    } catch (e) { Alert.alert('Error', 'Sin conexion al servidor'); }
  };

  const startLiveRecording = async () => {
    if (isRecordingRef.current) return;
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permiso requerido', 'Se necesita permiso de microfono'); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      isRecordingRef.current = true;
      setIsLiveListening(true);
      chunkIndexRef.current = 0;

      const recordChunk = async () => {
        if (!isRecordingRef.current) return;
        try {
          const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
          recordingRef.current = recording;
          await new Promise(resolve => setTimeout(resolve, 3000));
          if (!isRecordingRef.current) { try { await recording.stopAndUnloadAsync(); } catch(e) {} return; }
          await recording.stopAndUnloadAsync();
          const uri = recording.getURI();
          recordingRef.current = null;
          if (uri && socketRef.current) {
            const { FileSystem } = await import('expo-file-system');
            const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
            if (socketRef.current && isRecordingRef.current) {
              socketRef.current.emit('audio-chunk', { deviceId: childDeviceId, chunk: base64, chunkIndex: chunkIndexRef.current++, timestamp: Date.now() });
            }
            try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch(e) {}
          }
          if (isRecordingRef.current) setTimeout(recordChunk, 100);
        } catch (err) { if (isRecordingRef.current) setTimeout(recordChunk, 500); }
      };
      await recordChunk();
    } catch (err) { setIsLiveListening(false); isRecordingRef.current = false; }
  };

  const stopLiveRecording = () => {
    isRecordingRef.current = false; setIsLiveListening(false);
    if (recordingRef.current) { try { recordingRef.current.stopAndUnloadAsync(); } catch (e) {} recordingRef.current = null; }
  };

  const startLiveCamera = async () => {
    if (isLiveCamera) return;
    try {
      const { status } = await Camera.requestCameraPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permiso', 'Se necesita permiso de camara'); return; }
      setIsLiveCamera(true);
      setLiveCameraModal(true);

      liveCameraIntervalRef.current = setInterval(async () => {
        if (cameraRef.current && socketRef.current) {
          try {
            const photo = await cameraRef.current.takePictureAsync({ quality: 0.3, base64: true, skipProcessing: true });
            if (photo.base64 && socketRef.current) {
              socketRef.current.emit('live-camera-frame', {
                deviceId: childDeviceId,
                frame: photo.base64,
                timestamp: Date.now()
              });
            }
          } catch (e) {}
        }
      }, 1000);
    } catch (e) { console.log('Camera error:', e); }
  };

  const stopLiveCamera = () => {
    setIsLiveCamera(false);
    setLiveCameraModal(false);
    setLiveCameraFrame(null);
    if (liveCameraIntervalRef.current) { clearInterval(liveCameraIntervalRef.current); liveCameraIntervalRef.current = null; }
    if (socketRef.current) socketRef.current.emit('stop-live-camera', { deviceId: childDeviceId });
  };

  const viewRemoteCamera = () => {
    setLiveCameraModal(true);
    sendCommandToChild('start-live-camera');
    setTimeout(() => {}, 1000);
  };

  const playAudioChunk = async (base64Chunk, chunkIdx) => {
    try {
      if (soundRef.current) { await soundRef.current.unloadAsync(); soundRef.current = null; }
      const { FileSystem } = await import('expo-file-system');
      const filePath = `${FileSystem.cacheDirectory}chunk_${chunkIdx}.wav`;
      await FileSystem.writeAsStringAsync(filePath, base64Chunk, { encoding: FileSystem.EncodingType.Base64 });
      const { sound } = await Audio.Sound.createAsync({ uri: filePath }, { shouldPlay: true });
      soundRef.current = sound;
      setLiveChunksReceived(prev => prev + 1);
      sound.setOnPlaybackStatusUpdate((status) => { if (status.didJustFinish) soundRef.current = null; });
    } catch (err) { console.log('Error playing chunk:', err); }
  };

  const takeRemotePhoto = async (camera) => {
    if (socketRef.current) {
      socketRef.current.emit('take-photo', { deviceId: childDeviceId, camera: camera || 'front' });
    }
    await sendCommandToChild('take-photo', { camera: camera || 'front' });
  };

  const sendSOS = async () => {
    setSosActive(true);
    try {
      const { Location } = await import('expo-location');
      const { status } = await Location.requestForegroundPermissionsAsync();
      let locationData = {};
      if (status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        locationData = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      }
      if (socketRef.current) socketRef.current.emit('sos-alert', { deviceId: childDeviceId, ...locationData });
      await fetch(`${SERVER_URL}/api/send-to-parent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'sos', data: locationData, deviceId: childDeviceId })
      });
      await Notifications.scheduleNotificationAsync({
        content: { title: 'SOS ENVIADO', body: 'Tu ubicacion ha sido enviada a tus padres', sound: true },
        trigger: null,
      });
    } catch (e) { console.log('SOS error:', e); }
    setTimeout(() => setSosActive(false), 5000);
  };

  const sendChatMessage = () => {
    if (!chatInput.trim()) return;
    const msg = { text: chatInput.trim(), from: mode, timestamp: Date.now(), deviceId: childDeviceId };
    if (socketRef.current) socketRef.current.emit('chat-message', msg);
    setChatMessages(prev => [...prev, { text: chatInput.trim(), from: mode, time: new Date().toLocaleTimeString() }]);
    setChatInput('');
  };

  const trackLocationHistory = async () => {
    try {
      const { Location } = await import('expo-location');
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        const point = { latitude: loc.coords.latitude, longitude: loc.coords.longitude, timestamp: Date.now() };
        setLocationHistory(prev => [...prev, point].slice(-100));
        if (socketRef.current) {
          socketRef.current.emit('location-update', { deviceId: childDeviceId, ...point });
        }
        await fetch(`${SERVER_URL}/api/send-to-parent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'location-update', data: point, deviceId: childDeviceId })
        });
      }
    } catch (e) { console.log('Location error:', e); }
  };

  const executeChildCommand = async (command) => {
    setLastCommand(command);
    const result = { command: command.type, timestamp: new Date().toLocaleTimeString(), status: 'executed' };

    switch (command.type) {
      case 'listen-live': await startLiveRecording(); result.status = 'live-recording-started'; break;
      case 'stop-listen-live': stopLiveRecording(); result.status = 'live-recording-stopped'; break;
      case 'listen':
        try { await startLiveRecording(); setTimeout(() => stopLiveRecording(), 30000); result.status = 'recording-30s'; } catch (e) { result.status = 'error'; }
        break;
      case 'take-photo':
        try {
          const { status } = await Camera.requestCameraPermissionsAsync();
          if (status === 'granted') {
            if (cameraRef.current) {
              const photo = await cameraRef.current.takePictureAsync({ quality: 0.5, base64: true });
              if (photo.base64 && socketRef.current) {
                socketRef.current.emit('photo-result', { deviceId: childDeviceId, photo: photo.base64 });
              }
              result.status = 'photo-taken';
            }
          }
        } catch (e) { result.status = 'error: ' + e.message; }
        break;
      case 'start-live-camera': await startLiveCamera(); result.status = 'live-camera-started'; break;
      case 'stop-live-camera': stopLiveCamera(); result.status = 'live-camera-stopped'; break;
      case 'switch-camera':
        setCameraFacing(prev => prev === 'front' ? 'back' : 'front');
        result.status = 'camera-switched'; break;
      case 'start-camera': result.status = 'camera-started'; break;
      case 'start-screen': result.status = 'screen-mirroring-started'; break;
      case 'stop-screen': result.status = 'screen-mirroring-stopped'; break;
      case 'screenshot': result.status = 'screenshot-taken'; break;
      case 'get-location': await trackLocationHistory(); result.status = 'location-sent'; break;
      case 'track-location':
        try {
          const { Location } = await import('expo-location');
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
            setLocationHistory(prev => [...prev, { latitude: loc.coords.latitude, longitude: loc.coords.longitude, timestamp: Date.now() }].slice(-100));
            await fetch(`${SERVER_URL}/api/send-to-parent`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'location-update',
                data: { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
                deviceId: childDeviceId
              })
            });
            result.status = 'location-tracked';
          }
        } catch (e) { result.status = 'error'; }
        break;
      case 'get-battery':
        try {
          const { Battery } = await import('expo-battery');
          const level = await Battery.getBatteryLevelAsync();
          const state = await Battery.getBatteryStateAsync();
          await fetch(`${SERVER_URL}/api/send-to-parent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'battery-update', data: { level: Math.round(level * 100), isCharging: state === 2 }, deviceId: childDeviceId })
          });
          result.status = 'success';
        } catch (e) { result.status = 'error'; }
        break;
      case 'play-sound':
        try {
          await Notifications.scheduleNotificationAsync({
            content: { title: 'Alerta', body: 'Sonido de alarma', sound: true }, trigger: null,
          });
          result.status = 'success';
        } catch (e) { result.status = 'error'; }
        break;
      case 'send-notification':
        try {
          await Notifications.scheduleNotificationAsync({
            content: { title: 'Mensaje', body: command.message || 'Tienes un mensaje', sound: true }, trigger: null,
          });
          result.status = 'success';
        } catch (e) { result.status = 'error'; }
        break;
      case 'lock-device': result.status = 'needs-native-module'; break;
      case 'block-app':
        if (command.appName) {
          setBlockedApps(prev => [...prev, command.appName]);
          result.status = `blocked-${command.appName}`;
        }
        break;
      case 'unblock-app':
        if (command.appName) {
          setBlockedApps(prev => prev.filter(a => a !== command.appName));
          result.status = `unblocked-${command.appName}`;
        }
        break;
      case 'set-downtime':
        setDowntimeSchedule({ enabled: true, startHour: command.startHour || 22, endHour: command.endHour || 7 });
        result.status = 'downtime-set';
        break;
      case 'set-screen-time':
        setScreenTimeLimit(command.minutes || 120);
        result.status = 'screen-time-set';
        break;
      default: result.status = 'unknown-command';
    }

    setCommandResults(prev => [result, ...prev].slice(0, 20));
    try {
      await fetch(`${SERVER_URL}/api/send-to-parent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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
      setScreen('menu'); setMode(null);
      await AsyncStorage.removeItem('appMode');
      setSecretCode('');
    }
  };

  if (screen === 'loading') {
    return <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}><Text style={{ color: '#999', fontSize: 16 }}>Cargando...</Text></View>;
  }

  if (screen === 'hidden') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}><Text style={styles.title}>Acceso Secreto</Text></View>
        <View style={styles.center}>
          <TextInput style={styles.secretInput} placeholder="Codigo secreto" placeholderTextColor="#999" keyboardType="numeric" secureTextEntry value={secretCode} onChangeText={setSecretCode} onEndEditing={handleSecretAccess} />
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
            <Text style={styles.statusText}>{isLiveListening ? 'EN VIVO - Microfono activo...' : isLiveCamera ? 'EN VIVO - Camara activa...' : isConnected ? 'Conectado' : 'Verificando...'}</Text>
          </View>
          {isLiveListening && (
            <View style={[styles.statusCard, { marginTop: 10, backgroundColor: '#ffebee', borderColor: '#f44336', borderWidth: 1 }]}>
              <Text style={{ fontSize: 12, color: '#f44336', fontWeight: 'bold' }}>MICROFONO ACTIVO EN TIEMPO REAL</Text>
            </View>
          )}
          {isLiveCamera && (
            <View style={[styles.statusCard, { marginTop: 10, backgroundColor: '#e3f2fd', borderColor: '#1565c0', borderWidth: 1 }]}>
              <Text style={{ fontSize: 12, color: '#1565c0', fontWeight: 'bold' }}>CAMARA ACTIVA EN TIEMPO REAL</Text>
            </View>
          )}
          <Text style={[styles.info, { marginTop: 20, fontSize: 14, color: '#666' }]}>ID: {childDeviceId}</Text>
          {lastCommand && (
            <View style={[styles.statusCard, { marginTop: 15, backgroundColor: '#f0f0f0' }]}>
              <Text style={{ fontSize: 12, color: '#333' }}>Ultimo: {lastCommand.type}</Text>
            </View>
          )}
          <TouchableOpacity style={[styles.btn, { backgroundColor: sosActive ? '#f44336' : '#ff9800', marginTop: 30, width: 200 }]} onPress={sendSOS}>
            <Text style={styles.btnText}>{sosActive ? 'SOS ENVIADO!' : 'SOS'}</Text>
          </TouchableOpacity>
        </View>

        <Modal visible={isLiveCamera} transparent={true}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)' }}>
            <Camera ref={cameraRef} style={{ flex: 1 }} type={cameraFacing === 'front' ? Camera.Constants?.Type?.front : Camera.Constants?.Type?.back} ratio="4:3">
              <View style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 40 }}>
                <View style={{ backgroundColor: 'rgba(255,0,0,0.7)', padding: 10, borderRadius: 20 }}>
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>CAMARA ACTIVA - ENVIANDO EN VIVO</Text>
                </View>
              </View>
            </Camera>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: '#1a73e8', padding: 20 }]}>
        <Text style={styles.title}>Panel de Control</Text>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: isConnected ? '#4caf50' : '#f44336' }]} />
          <Text style={styles.statusText}>{isConnected ? 'Conectado' : 'Sin conexion'}</Text>
        </View>
        {childInfo && <Text style={[styles.statusText, { marginTop: 5, fontSize: 12 }]}>Hijo: {childInfo.manufacturer} {childInfo.modelName}</Text>}
      </View>

      <ScrollView style={{ flex: 1 }}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Camara en Vivo</Text>
          <TouchableOpacity style={[styles.cmdBtnFull, { backgroundColor: isLiveCamera ? '#f44336' : '#00897b', minHeight: 55 }]}
            onPress={() => {
              if (isLiveCamera) { stopLiveCamera(); if (socketRef.current) socketRef.current.emit('stop-live-camera', { deviceId: childDeviceId }); }
              else { viewRemoteCamera(); }
            }}>
            <Text style={[styles.cmdText, { fontSize: 15 }]}>{isLiveCamera ? 'DETENER CAMARA' : 'VER CAMARA EN VIVO'}</Text>
          </TouchableOpacity>
          <View style={[styles.row, { marginTop: 10 }]}>
            <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#4caf50' }]} onPress={() => takeRemotePhoto('front')}>
              <Text style={styles.cmdText}>Foto Frontal</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#2196f3' }]} onPress={() => takeRemotePhoto('back')}>
              <Text style={styles.cmdText}>Foto Trasera</Text>
            </TouchableOpacity>
          </View>
          {photos.length > 0 && (
            <View style={{ marginTop: 10 }}>
              <Text style={{ fontSize: 12, color: '#666' }}>Fotos recientes:</Text>
              {photos.slice(0, 3).map((p, i) => (
                <Text key={i} style={{ fontSize: 11, color: '#999' }}>{p.time} - Foto {i + 1}</Text>
              ))}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Espejo de Pantalla</Text>
          <TouchableOpacity style={[styles.cmdBtnFull, { backgroundColor: '#1565c0', minHeight: 55 }]}
            onPress={() => {
              setLiveCameraModal(true);
              sendCommandToChild('screenshot');
            }}>
            <Text style={[styles.cmdText, { fontSize: 15 }]}>VER PANTALLA DEL HIJO</Text>
          </TouchableOpacity>
          {liveCameraFrame && (
            <View style={{ marginTop: 10, alignItems: 'center' }}>
              <Image source={{ uri: liveCameraFrame }} style={{ width: SCREEN_WIDTH - 80, height: 200, borderRadius: 8, backgroundColor: '#000' }} resizeMode="contain" />
              <Text style={{ fontSize: 10, color: '#999', marginTop: 5 }}>Pantalla en vivo</Text>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Escuchar en Vivo</Text>
          <TouchableOpacity style={[styles.cmdBtnFull, { backgroundColor: isLiveReceiving ? '#f44336' : '#e91e63' }]} onPress={() => sendCommandToChild(isLiveReceiving ? 'stop-listen-live' : 'listen-live')}>
            <Text style={styles.cmdText}>{isLiveReceiving ? 'DETENER ESCUCHA' : 'ESCUCHAR EN VIVO'}</Text>
            {isLiveReceiving && <Text style={{ color: '#fff', fontSize: 11, marginTop: 4 }}>Chunks: {liveChunksReceived}</Text>}
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ubicacion</Text>
          <View style={styles.row}>
            <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#1a73e8' }]} onPress={() => sendCommandToChild('track-location')}>
              <Text style={styles.cmdText}>Ubicar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#4caf50' }]} onPress={() => sendCommandToChild('get-location')}>
              <Text style={styles.cmdText}>Historial</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#ff5722' }]} onPress={() => sendCommandToChild('get-battery')}>
              <Text style={styles.cmdText}>Bateria</Text>
            </TouchableOpacity>
          </View>
          <View style={[styles.row, { marginTop: 10 }]}>
            <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#9c27b0' }]} onPress={() => sendCommandToChild('play-sound')}>
              <Text style={styles.cmdText}>Alarma</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#607d8b' }]} onPress={() => Alert.prompt('Mensaje', 'Escribe:', (msg) => { if (msg) sendCommandToChild('send-notification', { message: msg }); })}>
              <Text style={styles.cmdText}>Mensaje</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Gestion de Apps</Text>
          <TouchableOpacity style={[styles.cmdBtnFull, { backgroundColor: '#ff9800' }]} onPress={() => Alert.prompt('App', 'Nombre de la app a bloquear:', (app) => { if (app) sendCommandToChild('block-app', { appName: app }); })}>
            <Text style={styles.cmdText}>Bloquear App</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtnFull, { backgroundColor: '#4caf50', marginTop: 10 }]} onPress={() => Alert.prompt('App', 'Nombre de la app a desbloquear:', (app) => { if (app) sendCommandToChild('unblock-app', { appName: app }); })}>
            <Text style={styles.cmdText}>Desbloquear App</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtnFull, { backgroundColor: '#1a73e8', marginTop: 10 }]} onPress={() => Alert.prompt('Minutos', 'Limite diario (minutos):', (min) => { if (min) sendCommandToChild('set-screen-time', { minutes: parseInt(min) }); })}>
            <Text style={styles.cmdText}>Limite de Pantalla</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Horario</Text>
          <TouchableOpacity style={[styles.cmdBtnFull, { backgroundColor: '#333' }]} onPress={() => Alert.prompt('Horario', 'Hora inicio (24h, ej: 22):', (start) => {
            if (start) Alert.prompt('Horario', 'Hora fin (24h, ej: 7):', (end) => {
              if (end) sendCommandToChild('set-downtime', { startHour: parseInt(start), endHour: parseInt(end) });
            });
          })}>
            <Text style={styles.cmdText}>Programar Inactividad</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Chat Familiar</Text>
          <ScrollView style={{ maxHeight: 150, marginBottom: 10 }}>
            {chatMessages.map((msg, i) => (
              <View key={i} style={{ padding: 5, backgroundColor: msg.from === 'padre' ? '#e3f2fd' : '#f3e5f5', borderRadius: 5, marginBottom: 5 }}>
                <Text style={{ fontSize: 12, fontWeight: 'bold' }}>{msg.from === 'padre' ? 'Padre' : 'Hijo'}</Text>
                <Text style={{ fontSize: 13 }}>{msg.text}</Text>
                <Text style={{ fontSize: 10, color: '#999' }}>{msg.time}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.row}>
            <TextInput style={[styles.chatInput, { flex: 1 }]} value={chatInput} onChangeText={setChatInput} placeholder="Escribe un mensaje..." />
            <TouchableOpacity style={[styles.smallBtn, { backgroundColor: '#1a73e8', marginLeft: 10 }]} onPress={sendChatMessage}>
              <Text style={{ color: '#fff', fontWeight: 'bold' }}>Enviar</Text>
            </TouchableOpacity>
          </View>
        </View>

        {history.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Historial ({history.length})</Text>
            {history.slice(0, 15).map((h, i) => (
              <View key={i} style={styles.histItem}>
                <Text style={{ fontSize: 13 }}>{h.cmd}</Text>
                <Text style={styles.histTime}>{h.time}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ padding: 20, gap: 10 }}>
          <TouchableOpacity style={[styles.btn, { backgroundColor: '#f44336' }]} onPress={() => { setMode(null); setScreen('menu'); AsyncStorage.removeItem('appMode'); cleanupSocket(); }}>
            <Text style={[styles.btnText, { fontSize: 14 }]}>Cerrar sesion</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal visible={liveCameraModal} animationType="slide" presentationStyle="fullScreen">
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 15, paddingTop: 50, backgroundColor: 'rgba(0,0,0,0.8)' }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>Camara en Vivo</Text>
            <TouchableOpacity onPress={() => { stopLiveCamera(); setLiveCameraModal(false); }}>
              <Text style={{ color: '#f44336', fontSize: 16, fontWeight: 'bold' }}>CERRAR</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            {liveCameraFrame ? (
              <Image source={{ uri: liveCameraFrame }} style={{ width: SCREEN_WIDTH, height: SCREEN_WIDTH * 1.3, resizeMode: 'contain' }} />
            ) : (
              <View style={{ alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 18 }}>Esperando camara del hijo...</Text>
                <Text style={{ color: '#999', fontSize: 13, marginTop: 10 }}>El hijo debe tener la app abierta</Text>
              </View>
            )}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'center', padding: 20, gap: 20, backgroundColor: 'rgba(0,0,0,0.8)' }}>
            <TouchableOpacity style={[styles.smallBtn, { backgroundColor: '#4caf50' }]}
              onPress={() => sendCommandToChild('switch-camera')}>
              <Text style={{ color: '#fff' }}>Cambiar Camara</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.smallBtn, { backgroundColor: '#ff9800' }]}
              onPress={() => sendCommandToChild('take-photo')}>
              <Text style={{ color: '#fff' }}>Tomar Foto</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { backgroundColor: '#1a73e8', padding: 30, alignItems: 'center' },
  title: { fontSize: 26, fontWeight: 'bold', color: '#fff' },
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
  statusCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 15, borderRadius: 10, width: '100%' },
  section: { backgroundColor: '#fff', margin: 10, padding: 15, borderRadius: 10 },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', color: '#333', marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  cmdBtn: { flex: 1, padding: 12, borderRadius: 10, marginHorizontal: 4, alignItems: 'center' },
  cmdBtnFull: { padding: 15, borderRadius: 10, alignItems: 'center' },
  cmdText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  histItem: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#eee' },
  histTime: { color: '#999', fontSize: 11 },
  secretInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 15, fontSize: 24, textAlign: 'center', width: 200, backgroundColor: '#fff', letterSpacing: 10 },
  chatInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, fontSize: 14, backgroundColor: '#fff' },
  smallBtn: { paddingVertical: 10, paddingHorizontal: 15, borderRadius: 8, justifyContent: 'center' },
});
