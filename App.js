import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, SafeAreaView,
  Alert, ScrollView, TextInput, Platform, Linking, AppState,
  NativeModules, DeviceEventEmitter
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

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
  const [childDevices, setChildDevices] = useState([]);
  const [pushToken, setPushToken] = useState(null);
  const [childToken, setChildToken] = useState(null);
  const [childDeviceId, setChildDeviceId] = useState('child');
  const [childInfo, setChildInfo] = useState(null);
  const [secretCode, setSecretCode] = useState('');
  const [lastCommand, setLastCommand] = useState(null);
  const [commandResults, setCommandResults] = useState([]);
  const [batteryLevel, setBatteryLevel] = useState(null);
  const [lastLocation, setLastLocation] = useState(null);
  const notificationListener = useRef();
  const responseListener = useRef();
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    loadSavedMode();
    setupNotifications();
    return () => {
      if (notificationListener.current) {
        Notifications.removeNotificationSubscription(notificationListener.current);
      }
      if (responseListener.current) {
        Notifications.removeNotificationSubscription(responseListener.current);
      }
    };
  }, []);

  useEffect(() => {
    if (mode === 'hijo') {
      registerChildDevice();
    } else if (mode === 'padre') {
      checkServer();
      const interval = setInterval(checkServer, 10000);
      return () => clearInterval(interval);
    }
  }, [mode]);

  const loadSavedMode = async () => {
    try {
      const savedMode = await AsyncStorage.getItem('appMode');
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
      handleNotificationReceived(notification);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      handleNotificationResponse(response);
    });
  };

  const handleNotificationReceived = (notification) => {
    const data = notification.request.content.data;
    if (data && data.command) {
      if (mode === 'hijo') {
        executeChildCommand(data.command);
      }
    }
  };

  const handleNotificationResponse = (response) => {
    const data = response.notification.request.content.data;
    if (data && data.action === 'open-parent') {
      setMode('padre');
      setScreen('padre');
      AsyncStorage.setItem('appMode', 'padre');
    }
  };

  const registerChildDevice = async () => {
    try {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        setPushToken(token);
        const deviceId = 'child_' + (await AsyncStorage.getItem('deviceId') || Math.random().toString(36).substr(2, 9));
        await AsyncStorage.setItem('deviceId', deviceId);
        setChildDeviceId(deviceId);

        await fetch(`${SERVER_URL}/api/register-device`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId,
            pushToken: token,
            platform: Platform.OS,
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
        setChildToken(deviceData.device?.pushToken || null);
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
        Alert.alert('Comando enviado', commandType);
      } else {
        Alert.alert('Error', data.message || 'No se pudo enviar');
      }
    } catch (e) {
      Alert.alert('Error', 'Sin conexión al servidor');
    }
  };

  const executeChildCommand = async (command) => {
    setLastCommand(command);

    const result = { command: command.type, timestamp: new Date().toLocaleTimeString(), status: 'executed' };

    switch (command.type) {
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
            setLastLocation(loc.coords);
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
          setBatteryLevel(Math.round(level * 100));
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

      case 'take-photo':
      case 'start-camera':
      case 'start-screen':
      case 'switch-camera':
      case 'stop-camera':
      case 'stop-screen':
      case 'screenshot':
        result.status = 'needs-native-module';
        await fetch(`${SERVER_URL}/api/send-to-parent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: command.type + '-response',
            data: { status: 'command-received', message: 'Función requiere build nativo personalizado' },
            deviceId: childDeviceId
          })
        });
        break;

      case 'send-notification':
        try {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Mensaje de Papá/Mamá',
              body: command.message || 'Tienes un mensaje',
              sound: true,
            },
            trigger: null,
          });
          result.status = 'success';
        } catch (e) { result.status = 'error'; }
        break;

      case 'lock-device':
      case 'volume-up':
      case 'volume-down':
      case 'press-back':
      case 'press-home':
        result.status = 'needs-native-module';
        break;

      default:
        result.status = 'unknown-command';
    }

    setCommandResults(prev => [result, ...prev].slice(0, 10));

    try {
      await fetch(`${SERVER_URL}/api/send-to-parent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'command-result',
          data: result,
          deviceId: childDeviceId
        })
      });
    } catch (e) {}
  };

  const selectMode = (selectedMode) => {
    setMode(selectedMode);
    setScreen(selectedMode);
    AsyncStorage.setItem('appMode', selectedMode);
  };

  const openAndroidSettings = () => {
    if (Platform.OS === 'android') {
      Linking.openURL('package:com.parentalcontrol.app').catch(() => {
        Linking.openURL('package:com.parentalcontrol.app');
      });
    }
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
            placeholder="Código secreto"
            placeholderTextColor="#999"
            keyboardType="numeric"
            secureTextEntry
            value={secretCode}
            onChangeText={setSecretCode}
            onEndEditing={handleSecretAccess}
          />
          <Text style={styles.info}>Ingresa el código para acceder</Text>
          <Text style={[styles.info, { fontSize: 12, color: '#999', marginTop: 10 }]}>
            Default: 1234
          </Text>
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
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: '#333', marginTop: 10 }]}
            onPress={() => setScreen('hidden')}
          >
            <Text style={[styles.btnText, { fontSize: 14 }]}>⚙ Configuración avanzada</Text>
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
              {isConnected ? 'Conectado - Servicios activos' : 'Verificando conexión...'}
            </Text>
          </View>

          <Text style={[styles.info, { marginTop: 20, fontSize: 14, color: '#666' }]}>
            ID: {childDeviceId}
          </Text>

          {pushToken && (
            <Text style={[styles.info, { fontSize: 10, color: '#999', marginTop: 5 }]} numberOfLines={1}>
              Token: {pushToken.substring(0, 30)}...
            </Text>
          )}

          {lastCommand && (
            <View style={[styles.statusCard, { marginTop: 15, backgroundColor: '#f0f0f0' }]}>
              <Text style={{ fontSize: 12, color: '#333' }}>Último comando: {lastCommand.type}</Text>
              <Text style={{ fontSize: 10, color: '#999' }}>{new Date(lastCommand.timestamp).toLocaleTimeString()}</Text>
            </View>
          )}

          {commandResults.length > 0 && (
            <View style={{ marginTop: 15, width: '100%', paddingHorizontal: 20 }}>
              <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#333', marginBottom: 5 }}>Historial</Text>
              {commandResults.slice(0, 5).map((r, i) => (
                <View key={i} style={styles.histItem}>
                  <Text style={{ fontSize: 12 }}>{r.command}</Text>
                  <Text style={{ fontSize: 10, color: r.status === 'success' ? '#4caf50' : '#999' }}>{r.status}</Text>
                </View>
              ))}
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
          <Text style={styles.statusText}>{isConnected ? 'Servidor conectado' : 'Sin conexión'}</Text>
        </View>
        {childInfo && (
          <Text style={[styles.statusText, { marginTop: 5, fontSize: 12 }]}>
            Hijo: {childInfo.manufacturer} {childInfo.modelName}
          </Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Cámara</Text>
        <View style={styles.row}>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#4caf50' }]} onPress={() => sendCommandToChild('start-camera')}>
            <Text style={styles.cmdText}>Iniciar</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#f44336' }]} onPress={() => sendCommandToChild('stop-camera')}>
            <Text style={styles.cmdText}>Detener</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#ff9800' }]} onPress={() => sendCommandToChild('switch-camera')}>
            <Text style={styles.cmdText}>Cambiar</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Pantalla</Text>
        <View style={styles.row}>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#1a73e8' }]} onPress={() => sendCommandToChild('start-screen')}>
            <Text style={styles.cmdText}>Espejo ON</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#f44336' }]} onPress={() => sendCommandToChild('stop-screen')}>
            <Text style={styles.cmdText}>Espejo OFF</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Acciones</Text>
        <View style={styles.row}>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#9c27b0' }]} onPress={() => sendCommandToChild('play-sound')}>
            <Text style={styles.cmdText}>Sonido</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#f44336' }]} onPress={() => sendCommandToChild('lock-device')}>
            <Text style={styles.cmdText}>Bloquear</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#1a73e8' }]} onPress={() => sendCommandToChild('get-location')}>
            <Text style={styles.cmdText}>Ubicación</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.row, { marginTop: 10 }]}>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#ff5722' }]} onPress={() => sendCommandToChild('get-battery')}>
            <Text style={styles.cmdText}>Batería</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#009688' }]} onPress={() => sendCommandToChild('screenshot')}>
            <Text style={styles.cmdText}>Pantalla</Text>
          </TouchableOpacity>
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
          <Text style={styles.sectionTitle}>Historial de Comandos</Text>
          {history.map((h, i) => (
            <View key={i} style={styles.histItem}>
              <Text style={{ fontSize: 13 }}>{h.cmd}</Text>
              <Text style={styles.histTime}>{h.time}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={{ padding: 20, gap: 10 }}>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#333' }]} onPress={() => checkServer()}>
          <Text style={[styles.btnText, { fontSize: 14 }]}>Actualizar estado</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#f44336' }]} onPress={() => {
          setMode(null);
          setScreen('menu');
          AsyncStorage.removeItem('appMode');
        }}>
          <Text style={[styles.btnText, { fontSize: 14 }]}>Cerrar sesión</Text>
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
  bigIcon: { fontSize: 80 },
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
  cmdBtn: { flex: 1, padding: 15, borderRadius: 10, marginHorizontal: 5, alignItems: 'center' },
  cmdText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  histItem: {
    flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  histTime: { color: '#999', fontSize: 12 },
  secretInput: {
    borderWidth: 1, borderColor: '#ddd', borderRadius: 10,
    padding: 15, fontSize: 24, textAlign: 'center', width: 200,
    backgroundColor: '#fff', letterSpacing: 10,
  },
});
