#!/usr/bin/env node
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

send({ type: 'server_ready', data: { serverVersion: 'fake-pi-app-server', protocolVersion: '2.0.0', transports: ['stdio'] } });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'create_session') {
    send({ id: msg.id, type: 'response', command: 'create_session', success: true, data: { sessionId: msg.sessionId, sessionInfo: sessionInfo(msg.sessionId) } });
  } else if (msg.type === 'switch_session') {
    send({ id: msg.id, type: 'response', command: 'switch_session', success: true, data: { sessionInfo: sessionInfo(msg.sessionId) } });
  } else if (msg.type === 'set_session_name') {
    send({ id: msg.id, type: 'response', command: 'set_session_name', success: true });
  } else if (msg.type === 'set_model') {
    send({ id: msg.id, type: 'response', command: 'set_model', success: true, data: { model: { provider: msg.provider, id: msg.modelId } } });
  } else if (msg.type === 'set_thinking_level') {
    send({ id: msg.id, type: 'response', command: 'set_thinking_level', success: true });
  } else if (msg.type === 'prompt') {
    setTimeout(() => {
      send({ type: 'event', sessionId: msg.sessionId, event: { type: 'agent_start', message: 'fake Pi worker started' } });
      send({ type: 'event', sessionId: msg.sessionId, event: { type: 'message_end', message: { usage: { input: 4, output: 3, total: 7 } } } });
      send({ id: msg.id, type: 'response', command: 'prompt', success: true });
    }, 5);
  } else if (msg.type === 'get_last_assistant_text') {
    send({ id: msg.id, type: 'response', command: 'get_last_assistant_text', success: true, data: { text: 'OK' } });
  } else if (msg.type === 'abort') {
    send({ id: msg.id, type: 'response', command: 'abort', success: true });
  } else if (msg.type === 'extension_ui_response') {
    send({ id: msg.id, type: 'response', command: 'extension_ui_response', success: true });
  } else {
    send({ id: msg.id, type: 'response', command: msg.type || 'unknown', success: false, error: `unsupported fake command: ${msg.type}` });
  }
});

function sessionInfo(sessionId) {
  return { sessionId, thinkingLevel: 'medium', isStreaming: false, messageCount: 0, createdAt: new Date().toISOString() };
}
