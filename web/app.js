const $ = id => document.getElementById(id);
let snapshot, group, messages = [], after = 0, endpoint, historyAfter = 0, loading = false;
let modelState = null, modelObservations = [], modelAfter = 0;
const text = (tag, content, className) => { const node = document.createElement(tag); node.textContent = content; if (className) node.className = className; return node; };
async function api(path) { const response = await fetch(path); if (!response.ok) throw new Error(await response.text()); return response.json(); }
function name(id) { return id === 'system' ? '系统' : snapshot.members.find(member => member.id === id)?.name ?? id; }
function pairOf(message) { return [message.sender, message.recipient].sort().join(':'); }
function modelValue(observation) {
  if (!observation) return '未知';
  if (observation.model) return observation.model;
  if (observation.models?.length) return observation.models.join(', ');
  return '未知';
}
function observationMeta(observation) {
  return [observation.phase, observation.source, observation.turnId ? `turn ${observation.turnId}` : null].filter(Boolean).join(' · ');
}
function showMessages() {
  const filter = $('pair').value;
  const list = filter ? messages.filter(message => pairOf(message) === filter) : messages;
  $('messages').replaceChildren(...list.map(message => {
    const article = text('article', '', `message ${message.kind}`);
    article.append(text('div', `${name(message.sender)} → ${name(message.recipient)} · ${message.kind === 'note' ? '留言' : message.kind === 'system' ? '通知' : '对话'} · ${new Date(message.created).toLocaleTimeString()}`, 'meta'), text('div', message.text, 'body'), text('div', message.id, 'id'));
    return article;
  }));
  if (!list.length) $('messages').append(text('div', '还没有群消息。成员只通过工具在群里发言。', 'empty'));
}
async function loadMessages(reset = false) {
  if (!group) return;
  const selected = group;
  if (reset) { messages = []; after = 0; }
  const rows = await api(`/api/messages?group=${encodeURIComponent(group)}&after=${after}`);
  if (selected !== group) return;
  messages.push(...rows); after = rows.at(-1)?.seq ?? after;
  const selectedPair = $('pair').value;
  $('pair').replaceChildren(new Option('全部对话', ''));
  const pairs = new Map(messages.filter(message => message.sender !== 'system').map(message => [pairOf(message), `${name(message.sender)} ↔ ${name(message.recipient)}`]));
  for (const [value, label] of pairs) $('pair').append(new Option(label, value));
  $('pair').value = pairs.has(selectedPair) ? selectedPair : '';
  showMessages();
  $('more').hidden = rows.length < 200;
}
async function loadHistory(id, reset = true) {
  if (reset) { endpoint = id; historyAfter = 0; modelAfter = 0; modelObservations = []; modelState = null; $('history').replaceChildren(text('h2', '宿主事件观测记录'), text('p', '宿主输出的事件流，可能包含宿主自身的截断；不等同于原生完整历史。', 'sub')); }
  const rows = await api(`/api/history?endpoint=${encodeURIComponent(id)}&after=${historyAfter}`);
  if (endpoint !== id) return;
  $('history').querySelector('button')?.remove();
  for (const row of rows) {
    const event = JSON.parse(row.event), details = document.createElement('details');
    details.append(text('summary', `#${row.seq} ${event.method ?? event.type ?? 'event'}`), text('pre', JSON.stringify(event, null, 2))); $('history').append(details);
  }
  historyAfter = rows.at(-1)?.seq ?? historyAfter;
  if (rows.length === 200) { const more = text('button', '加载后续事件'); more.onclick = () => loadHistory(id, false).catch(showError); $('history').append(more); }
}
function showModels() {
  const container = $('models');
  if (endpoint == null) return container.replaceChildren();
  const current = document.createElement('section');
  current.className = 'model-card';
  current.append(text('h3', '当前模型'));
  for (const [label, observation] of [
    ['模型', modelState?.currentModel],
    ['思考强度', modelState?.currentReasoningEffort],
  ]) {
    const value = label === '模型' ? modelValue(observation) : observation?.reasoningEffort ?? '未知';
    const row = text('div', '', 'model-current');
    row.append(
      text('span', label, 'model-label'),
      text('strong', value),
      text('small', observation ? observationMeta(observation) : '宿主尚未报告'),
    );
    current.append(row);
  }
  const timeline = document.createElement('section');
  timeline.className = 'model-card';
  timeline.append(text('h3', '模型变化'), text('p', '模型变化来自宿主消息流；当前值由这些观测按来源优先级推导。', 'sub'));
  if (!modelObservations.length) timeline.append(text('div', '本会话还没有模型观测。', 'empty compact'));
  else timeline.append(...modelObservations.map(observation => {
    const row = document.createElement('details');
    row.className = 'model-event';
    row.append(
      text('summary', `#${observation.seq} ${observation.phase} · ${modelValue(observation)}${observation.reasoningEffort ? ` · ${observation.reasoningEffort}` : ''}`),
      text('pre', JSON.stringify(observation, null, 2)),
    );
    return row;
  }));
  container.replaceChildren(current, timeline);
}
async function loadModels(id, reset = true) {
  if (reset) {
    endpoint = id; modelAfter = 0; modelObservations = []; modelState = null;
    $('models').replaceChildren(text('h2', '模型观测'), text('p', '读取本会话的模型与思考强度记录。', 'sub'));
  }
  const result = await api(`/api/models?endpoint=${encodeURIComponent(id)}&after=${modelAfter}`);
  if (endpoint !== id) return;
  modelState = result;
  modelObservations.push(...result.observations);
  modelAfter = result.nextAfter;
  showModels();
}
function showError(error) { $('error').textContent = error.message; $('connection').textContent = '连接异常'; }
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    snapshot = await api('/api/snapshot');
    if (!snapshot.groups.some(item => item.id === group)) { group = snapshot.groups[0]?.id; messages = []; after = 0; endpoint = null; $('history').replaceChildren(); $('models').replaceChildren(); }
    $('groups').replaceChildren(...snapshot.groups.map(item => { const button = text('button', item.name, item.id === group ? 'selected' : ''); button.title = item.name; button.onclick = async () => { group = item.id; messages = []; after = 0; endpoint = null; $('history').replaceChildren(); $('models').replaceChildren(); await refresh(); }; return button; }));
    const current = snapshot.groups.find(item => item.id === group);
    $('title').textContent = current?.name ?? '还没有群';
    $('members').replaceChildren(...snapshot.members.filter(member => member.group_id === group && !member.removed).map(member => { const card = text('div', '', 'member'); card.append(text('strong', `${member.name} · ${member.role === 'lead' ? '主 Agent' : member.host}`), text('p', member.profile || '尚未提交能力自述')); return card; }));
    $('sessions').replaceChildren(...snapshot.endpoints.filter(item => item.group_id === group).map(item => {
      const button = text('button', `${name(item.member_id)} · ${item.peer ? `与 ${name(item.peer)} 对话` : '入群自述'}`, 'session');
      const model = item.modelState?.currentModel?.model ?? '模型未知';
      const effort = item.modelState?.currentReasoningEffort?.reasoningEffort ?? '强度未知';
      button.append(
        text('small', `${snapshot.runningEndpoints.includes(item.id) ? '宿主回合运行中 · ' : ''}${item.session ?? '尚无宿主会话引用'}`),
        text('small', `${model} · ${effort}`, 'model-summary'),
      );
      button.onclick = () => Promise.all([loadHistory(item.id), loadModels(item.id)]).catch(showError);
      return button;
    }));
    if (group) await loadMessages(); else $('messages').replaceChildren(text('div', '在 CLI 创建群后，这里会自动显示。', 'empty'));
    if (endpoint) await Promise.all([loadHistory(endpoint, false), loadModels(endpoint, false)]);
    $('connection').textContent = '本机 · 已连接'; $('error').textContent = '';
  } catch (error) { showError(error); }
  finally { loading = false; }
}
$('pair').onchange = showMessages;
$('more').onclick = () => loadMessages().catch(showError);
await refresh(); setInterval(refresh, 2000);
