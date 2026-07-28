import React, { useState } from 'react';
import { View, Text, TouchableOpacity, SafeAreaView } from 'react-native';

export default function App() {
  const [screen, setScreen] = useState('menu');

  if (screen === 'menu') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#f5f5f5', justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 30 }}>Control Parental</Text>
        <TouchableOpacity
          style={{ backgroundColor: '#1a73e8', padding: 20, borderRadius: 10, margin: 10, width: 250, alignItems: 'center' }}
          onPress={() => setScreen('padre')}>
          <Text style={{ color: '#fff', fontSize: 18 }}>Soy el Padre</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={{ backgroundColor: '#4caf50', padding: 20, borderRadius: 10, margin: 10, width: 250, alignItems: 'center' }}
          onPress={() => setScreen('hijo')}>
          <Text style={{ color: '#fff', fontSize: 18 }}>Soy el Hijo</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f5f5f5', justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ fontSize: 20, fontWeight: 'bold', marginBottom: 20 }}>
        {screen === 'padre' ? 'Panel Padre' : 'Modo Hijo'}
      </Text>
      <Text style={{ fontSize: 16, color: '#666', marginBottom: 30 }}>Version funcional</Text>
      <TouchableOpacity
        style={{ backgroundColor: '#f44336', padding: 15, borderRadius: 10 }}
        onPress={() => setScreen('menu')}>
        <Text style={{ color: '#fff', fontSize: 16 }}>Volver</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
