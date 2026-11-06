#!/usr/bin/env node
/**
 * 长历史性能基线:在隔离临时目录里构造指定规模的消息/回合,测量关键查询耗时。
 *
 * 用途:为后续性能改动提供可对比的基线;不改用户运行数据(临时目录,结束即删)。
 * 用法:BENCH_MESSAGES=2000 BENCH_TURNS=500 node scripts/perf-baseline.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.mjs';

const messages = Number(process.env.BENCH_MESSAGES ?? 2000);
const turns = Number(process.env.BENCH_TURNS ?? 500);
const rounds = Number(process.env.BENCH_ROUNDS ?? 20);
const directory = mkdtempSync(join(tmpdir(), 'agent-team-perf-'));

function timed(label, run) {
  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    minMs: Number(samples[0].toFixed(2)),
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(2)),
    maxMs: Number(samples[samples.length - 1].toFixed(2)),
  };
}

const store = new Store(directory);
try {
  const now = new Date().toISOString();
  store.run(
    "INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES('g1','bench','/tmp',NULL,?,NULL,'workspace-write',0)",
    now,
  );
  for (let index = 0; index < 5; index += 1) {
    store.run(
      'INSERT INTO members(id,group_id,name,host,role,profile) VALUES(?,?,?,?,?,?)',
      `m${index}`, 'g1', `member-${index}`, 'codex', index === 0 ? 'lead' : 'member', '',
    );
  }
  const conversation = store.conversation('member', 'm1', 'coordination');
  store.transaction(() => {
    for (let index = 0; index < messages; index += 1) {
      store.run(
        'INSERT INTO messages(id,group_id,sender,recipient,kind,text,reply_to,created,awaiting,expects_reply) VALUES(?,?,?,?,?,?,?,?,?,?)',
        `msg-${index}`, 'g1', index % 2 ? 'm1' : 'm2', 'm3', 'note', `message body ${index}`, null,
        new Date(Date.parse(now) + index).toISOString(), 0, 0,
      );
    }
    for (let index = 0; index < turns; index += 1) {
      store.run(
        'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,active_team_id,source_user_message_id,state,detail,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        `turn-${index}`, conversation.id, 'member', 'm1', 'g1', null, null, null,
        index % 10 === 0 ? 'unknown' : 'completed', null,
        new Date(Date.parse(now) + index).toISOString(),
      );
    }
  });

  const results = [
    timed('最新 200 条消息', () => store.all(
      'SELECT * FROM messages WHERE group_id=? ORDER BY seq DESC LIMIT 200', 'g1',
    )),
    timed('历史分页 200 条', () => store.all(
      'SELECT * FROM messages WHERE group_id=? AND seq<? ORDER BY seq DESC LIMIT 200', 'g1', messages - 100,
    )),
    timed('消息总量', () => store.get('SELECT count(*) AS c FROM messages WHERE group_id=?', 'g1')),
    timed('会话最近 200 个回合', () => store.all(
      'SELECT * FROM turns WHERE conversation_id=? ORDER BY created DESC LIMIT 200', conversation.id,
    )),
    timed('待投递队列', () => store.all(
      'SELECT o.rowid AS rowid,o.* FROM outbox o WHERE o.accepted IS NULL AND o.error IS NULL',
    )),
    timed('未知回合计数', () => store.get(
      "SELECT count(*) AS c FROM turns WHERE group_id='g1' AND state='unknown'",
    )),
  ];

  console.log(JSON.stringify({
    version: 1,
    scale: { messages, turns, members: 5 },
    rounds,
    results,
  }, null, 2));
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
