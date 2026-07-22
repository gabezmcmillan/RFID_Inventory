import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

import { STATUS_IN } from '@rfid/domain';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>RFID Field — domain wired ({STATUS_IN})</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
