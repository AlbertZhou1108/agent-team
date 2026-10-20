import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
const directory = resolve(process.argv[2]);
const store = new Store(directory);
try {
  const messages = store.all("SELECT m.*,p.host FROM messages m JOIN members p ON p.id=m.sender WHERE m.kind='send' ORDER BY m.seq");
  assert.ok(messages.length >= 4);
  const traces = messages.map(message => {
    const trace = store.messageTrace(message.id);
    assert.ok(trace.inputAttempts.length > 0);
    if (message.host === 'codex' && trace.source.kind === 'private') {
      assert.deepEqual(trace.source, { kind: 'private' });
    } else {
      assert.equal(trace.source.kind, 'group');
      const turn = store.turnTrace(trace.source.turnId, trace.source.eventSeq - 1);
      const call = JSON.parse(turn.events.find(event => event.seq === trace.source.eventSeq).event);
      assert.equal(call.name, 'send');
      assert.equal(call.args.text, message.text);
      assert.ok(turn.outgoingMessages.some(row => row.message_id === message.id));
    }
    for (const attempt of trace.inputAttempts) assert.ok(store.turnTrace(attempt.id).inputMessages.some(row => row.id === message.id));
    return { host: message.host, ...trace };
  });
  for (const host of ['codex', 'claude', 'dsh']) assert.ok(traces.some(trace => trace.host === host));
  const result = { passed: true, checked: new Date().toISOString(), traces };
  writeFileSync(resolve(directory, 'provenance-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, messages: traces.length, hosts: [...new Set(traces.map(trace => trace.host))] }));
} finally { store.close(); }
