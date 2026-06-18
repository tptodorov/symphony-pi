#!/usr/bin/env node
const { StringDecoder } = require('node:string_decoder');

const decoder = new StringDecoder('utf8');
let buffer = '';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk);
  while (true) {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) break;
    let line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'get_state') {
      send({ id: msg.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'fake-rpc-session', thinkingLevel: 'medium', isStreaming: false, isCompacting: false, steeringMode: 'all', followUpMode: 'one-at-a-time', autoCompactionEnabled: false, messageCount: 0, pendingMessageCount: 0 } });
    } else if (msg.type === 'get_messages') {
      send({ id: msg.id, type: 'response', command: 'get_messages', success: true, data: { messages: [] } });
    } else if (msg.type === 'set_session_name') {
      send({ id: msg.id, type: 'response', command: 'set_session_name', success: true });
    } else if (msg.type === 'set_model') {
      send({ id: msg.id, type: 'response', command: 'set_model', success: true, data: { model: { provider: msg.provider, id: msg.modelId } } });
    } else if (msg.type === 'set_thinking_level') {
      send({ id: msg.id, type: 'response', command: 'set_thinking_level', success: true });
    } else if (msg.type === 'prompt') {
      send({ id: msg.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        send({ type: 'agent_start', message: 'fake Pi RPC worker started' });
        send({ type: 'message_end', message: { usage: { input: 4, output: 3, total: 7 } } });
        send({ type: 'agent_end', messages: [], willRetry: false });
      }, 5);
    } else if (msg.type === 'get_last_assistant_text') {
      send({ id: msg.id, type: 'response', command: 'get_last_assistant_text', success: true, data: { text: 'OK' } });
    } else if (msg.type === 'abort') {
      send({ id: msg.id, type: 'response', command: 'abort', success: true });
    } else if (msg.type === 'extension_ui_response') {
      send({ id: msg.id, type: 'response', command: 'extension_ui_response', success: true });
    } else {
      send({ id: msg.id, type: 'response', command: msg.type || 'unknown', success: false, error: `unsupported fake RPC command: ${msg.type}` });
    }
  }
});
process.stdin.on('end', () => {
  buffer += decoder.end();
  if (!buffer.trim()) return;
  const msg = JSON.parse(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
  send({ id: msg.id, type: 'response', command: msg.type || 'unknown', success: false, error: `unsupported trailing fake RPC command: ${msg.type}` });
});
