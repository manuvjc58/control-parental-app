import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView, Alert, ScrollView } from 'react-native';

const SERVER_URL = 'https://parental-control-server-production-5044.up.railway.app';

export default function App() {
  const [screen, setScreen] = useState('menu');
  const [isConnected, setIsConnected] = useState(false);
  const [history, setHistory] = useState([]);

  const checkServer = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/health`);
      const data = await res.json();
      setIsConnected(data.status === 'ok');
      return data.status === 'ok';
    } catch (e) {
      setIsConnected(false);
      return false;
    }
  };

  const sendCommand = async (cmd) => {
    const ok = await checkServer();
    if (!ok) {
      Alert.alert('Error', 'No hay conexión al servidor');
      return;
    }
    try {
      await fetch(`${SERVER_URL}/api/send-command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: { type: cmd }, deviceId: 'child' })
      });
      setHistory(prev => [{ cmd, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 5));
      Alert.alert('Enviado', cmd);
    } catch (e) {
      Alert.alert('Error', 'No se pudo enviar');
    }
  };

  if (screen === 'menu') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Control Parental</Text>
        </View>
        <View style={styles.buttons}>
          <TouchableOpacity style={[styles.btn, { backgroundColor: '#1a73e8' }]} onPress={() => setScreen('padre')}>
            <Text style={styles.btnText}>Soy el Padre</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, { backgroundColor: '#4caf50' }]} onPress={() => setScreen('hijo')}>
            <Text style={styles.btnText}>Soy el Hijo</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'hijo') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.header, { backgroundColor: '#4caf50' }]}>
          <Text style={styles.title}>Modo Hijo</Text>
          <Text style={styles.subtitle}>Dispositivo monitoreado</Text>
        </View>
        <View style={styles.center}>
          <Text style={styles.bigIcon}>📱</Text>
          <Text style={styles.info}>Este teléfono está siendo controlado</Text>
          <TouchableOpacity style={[styles.btn, { backgroundColor: '#f44336', marginTop: 20 }]} onPress={() => setScreen('menu')}>
            <Text style={styles.btnText}>Volver</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Panel de Control</Text>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: isConnected ? '#4caf50' : '#f44336' }]} />
          <Text style={styles.statusText}>{isConnected ? 'Conectado' : 'Desconectado'}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Cámara</Text>
        <View style={styles.row}>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#4caf50' }]} onPress={() => sendCommand('start-camera')}>
            <Text style={styles.cmdText}>Iniciar</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#f44336' }]} onPress={() => sendCommand('stop-camera')}>
            <Text style={styles.cmdText}>Detener</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#ff9800' }]} onPress={() => sendCommand('switch-camera')}>
            <Text style={styles.cmdText}>Cambiar</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Pantalla</Text>
        <View style={styles.row}>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#1a73e8' }]} onPress={() => sendCommand('start-screen')}>
            <Text style={styles.cmdText}>Espejo ON</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#f44336' }]} onPress={() => sendCommand('stop-screen')}>
            <Text style={styles.cmdText}>Espejo OFF</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Acciones</Text>
        <View style={styles.row}>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#9c27b0' }]} onPress={() => sendCommand('play-sound')}>
            <Text style={styles.cmdText}>Sonido</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#f44336' }]} onPress={() => sendCommand('lock-device')}>
            <Text style={styles.cmdText}>Bloquear</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cmdBtn, { backgroundColor: '#1a73e8' }]} onPress={() => sendCommand('get-location')}>
            <Text style={styles.cmdText}>Ubicación</Text>
          </TouchableOpacity>
        </View>
      </View>

      {history.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Historial</Text>
          {history.map((h, i) => (
            <View key={i} style={styles.histItem}>
              <Text>{h.cmd}</Text>
              <Text style={styles.histTime}>{h.time}</Text>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity style={[styles.btn, { backgroundColor: '#666', margin: 20 }]} onPress={() => setScreen('menu')}>
        <Text style={styles.btnText}>Volver</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { backgroundColor: '#1a73e8', padding: 30, alignItems: 'center' },
  title: { fontSize: 28, fontWeight: 'bold', color: '#fff' },
  subtitle: { fontSize: 14, color: 'rgba(255,255,255,0.8)', marginTop: 5 },
  buttons: { flex: 1, justifyContent: 'center', padding: 30, gap: 20 },
  btn: { padding: 20, borderRadius: 15, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30 },
  bigIcon: { fontSize: 80 },
  info: { fontSize: 18, color: '#333', marginTop: 20, textAlign: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  statusText: { color: '#fff', fontSize: 14 },
  section: { backgroundColor: '#fff', margin: 15, padding: 15, borderRadius: 10 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  cmdBtn: { flex: 1, padding: 15, borderRadius: 10, marginHorizontal: 5, alignItems: 'center' },
  cmdText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  histItem: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#eee' },
  histTime: { color: '#999', fontSize: 12 },
});