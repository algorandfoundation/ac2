import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@tanstack/react-store';
import { messagesStore, Message, clearMessages } from '@/stores/messages';
import { useConnection } from '@/hooks/useConnection';

export default function ChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ origin: string; requestId: string }>();
  const [inputText, setInputText] = useState('');
  const { isConnected, isLoading, isError, send, lastHeartbeat, reset, address } = useConnection(
    params.origin || '',
    params.requestId || '',
  );

  const { messages } = useStore(messagesStore, (state) => ({
    messages: state.messages.filter(
      (m) =>
        m.origin === params.origin &&
        m.requestId === params.requestId &&
        (address ? m.address === address : true),
    ),
  }));

  const flatListRef = useRef<FlatList>(null);

  const [isHeartbeatVisible, setIsHeartbeatVisible] = useState(false);

  useEffect(() => {
    if (isConnected) {
      setIsHeartbeatVisible(true);
      const timer = setTimeout(() => setIsHeartbeatVisible(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [lastHeartbeat, isConnected]);

  // Scroll to bottom when keyboard opens
  useEffect(() => {
    const keyboardDidShowListener = Keyboard.addListener('keyboardDidShow', () => {
      flatListRef.current?.scrollToEnd({ animated: true });
    });

    return () => {
      keyboardDidShowListener.remove();
    };
  }, []);

  const handleDisconnect = () => {
    reset();
    router.back();
  };

  const handleSend = () => {
    if (inputText.trim()) {
      send(inputText.trim());
      setInputText('');
    }
  };

  const renderItem = ({ item }: { item: Message }) => (
    <View
      style={[styles.messageBubble, item.sender === 'me' ? styles.myMessage : styles.peerMessage]}
    >
      <Text
        style={[
          styles.messageText,
          item.sender === 'me' ? styles.myMessageText : styles.peerMessageText,
        ]}
      >
        {item.text}
      </Text>
      <Text style={[styles.timestamp, item.sender === 'me' && styles.myTimestamp]}>
        {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <Stack.Screen
        options={{
          title: isConnected
            ? 'Connected'
            : isLoading
              ? 'Connecting...'
              : isError
                ? 'Error'
                : 'Disconnected',
          headerShown: true,
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.back()} style={{ marginLeft: 10 }}>
              <MaterialIcons name="arrow-back" size={24} color="#3B82F6" />
            </TouchableOpacity>
          ),
          headerRight: () =>
            isConnected ? (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {isHeartbeatVisible && (
                  <MaterialIcons
                    name="favorite"
                    size={16}
                    color="#10B981"
                    style={{ marginRight: 10 }}
                  />
                )}
                <TouchableOpacity
                  onPress={() =>
                    address && clearMessages(address, params.origin || '', params.requestId || '')
                  }
                  style={{ marginRight: 15 }}
                >
                  <MaterialIcons name="delete-outline" size={24} color="#6B7280" />
                </TouchableOpacity>
                <TouchableOpacity onPress={handleDisconnect} style={{ marginRight: 15 }}>
                  <MaterialIcons name="link-off" size={24} color="#EF4444" />
                </TouchableOpacity>
              </View>
            ) : null,
        }}
      />

      <KeyboardAvoidingView style={{ flex: 1 }}>
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={{ display: 'flex', height: '100%' }}>
            <FlatList
              ref={flatListRef}
              data={messages}
              renderItem={renderItem}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.messageList}
              inverted={false}
              onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
              onLayout={() => flatListRef.current?.scrollToEnd({ animated: true })}
            />

            <View style={styles.inputContainer}>
              <TextInput
                style={styles.input}
                value={inputText}
                onChangeText={setInputText}
                placeholder={isConnected ? 'Type a message...' : 'Connecting...'}
                placeholderTextColor="#94A3B8"
                editable={isConnected}
              />
              <TouchableOpacity
                style={[
                  styles.sendButton,
                  (!inputText.trim() || !isConnected) && styles.sendButtonDisabled,
                ]}
                onPress={handleSend}
                disabled={!inputText.trim() || !isConnected}
              >
                <MaterialIcons name="send" size={24} color="white" />
              </TouchableOpacity>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  messageList: {
    padding: 16,
    paddingBottom: 20,
    flexGrow: 1,
  },
  messageBubble: {
    maxWidth: '85%',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    marginBottom: 8,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1,
  },
  myMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#3B82F6',
    borderBottomRightRadius: 4,
    borderTopRightRadius: 16,
    borderTopLeftRadius: 16,
    borderBottomLeftRadius: 16,
  },
  peerMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#E2E8F0',
    borderBottomLeftRadius: 4,
    borderTopRightRadius: 16,
    borderTopLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  myMessageText: {
    color: 'white',
  },
  peerMessageText: {
    color: '#1E293B',
  },
  timestamp: {
    fontSize: 10,
    marginTop: 4,
    alignSelf: 'flex-end',
    color: 'rgba(0,0,0,0.5)',
  },
  myTimestamp: {
    color: 'rgba(255,255,255,0.7)',
  },
  inputContainer: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'white',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    alignItems: 'flex-end',
    paddingBottom: Platform.OS === 'ios' ? 8 : 12,
  },
  input: {
    flex: 1,
    backgroundColor: '#F1F5F9',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 10,
    fontSize: 16,
    maxHeight: 120,
    color: '#1E293B',
  },
  sendButton: {
    backgroundColor: '#3B82F6',
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
  },
  sendButtonDisabled: {
    backgroundColor: '#CBD5E1',
  },
});
