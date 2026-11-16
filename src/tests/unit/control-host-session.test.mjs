import test from 'node:test';
import assert from 'node:assert/strict';
import { controlHostContext, controlHostSession } from '../../rpc.mjs';

test('control host session distinguishes top-level Codex from nested subagent threads', () => {
  assert.equal(controlHostSession({
    CODEX_THREAD_ID: 'thread-root',
    CODEX_SESSION_ID: 'thread-root',
  }), 'thread-root');
  assert.equal(controlHostSession({
    CODEX_THREAD_ID: 'thread-child',
    CODEX_SESSION_ID: 'thread-root',
  }), null);
  assert.equal(controlHostContext({
    CODEX_THREAD_ID: 'thread-child',
    CODEX_SESSION_ID: 'thread-root',
  }).clearExistingSession, true);
});

test('control host session supports explicit wakeable sessions and a wake disable switch', () => {
  assert.equal(controlHostSession({
    AGENT_TEAM_HOST_SESSION: 'explicit-thread',
    CODEX_THREAD_ID: 'thread-child',
    CODEX_SESSION_ID: 'thread-root',
  }), 'explicit-thread');
  assert.equal(controlHostSession({
    AGENT_TEAM_DISABLE_ACTIVE_WAKE: '1',
    AGENT_TEAM_HOST_SESSION: 'explicit-thread',
    CODEX_THREAD_ID: 'thread-root',
    CODEX_SESSION_ID: 'thread-root',
  }), null);
  assert.equal(controlHostContext({ AGENT_TEAM_DISABLE_ACTIVE_WAKE: '1' }).clearExistingSession, true);
  assert.equal(controlHostSession({ CLAUDE_SESSION_ID: 'claude-thread' }), 'claude-thread');
  assert.equal(controlHostSession({ ZCODE_SESSION_ID: 'sess-zcode' }), 'sess-zcode');
  assert.equal(controlHostSession({ DSH_SESSION_ID: 'session-dsh' }), 'session-dsh');
  assert.equal(controlHostSession({ ZCODE_SESSION_ID: 'sess-zcode', DSH_SESSION_ID: 'session-dsh' }), 'sess-zcode');
  assert.equal(controlHostSession({ CODEX_SESSION_ID: 'codex-first', ZCODE_SESSION_ID: 'sess-zcode' }), 'codex-first');
  assert.equal(controlHostSession({}), null);
});
