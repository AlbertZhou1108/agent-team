// 遥测公共门面:对外 API 与行为保持不变;聚合实现拆在 telemetry/{write,batch,view,query}.mjs。
import * as batch from './telemetry/batch.mjs';
import * as query from './telemetry/query.mjs';
import * as view from './telemetry/view.mjs';
import * as write from './telemetry/write.mjs';

export { TelemetryQueryError } from './telemetry/write.mjs';
export { telemetryObservation } from './observation.mjs';

export class Telemetry {
  constructor(store, { capabilityFor = () => null } = {}) {
    this.store = store;
    this.capabilityFor = capabilityFor;
  }

  record(args) { return write.record(this, args); }
  rotateSession(endpointId, sessionKey = null) { return write.rotateSession(this, endpointId, sessionKey); }

  managerConversation(groupId, controller, memberId, options = {}) { return query.managerConversation(this, groupId, controller, memberId, options); }
  conversation(groupId, memberId, peerId, options = {}) { return query.conversation(this, groupId, memberId, peerId, options); }
  coordination(groupId, controller, options = {}) { return query.coordination(this, groupId, controller, options); }
  members(groupId, options = {}) { return query.members(this, groupId, options); }
  capabilities(groupId, controllers = []) { return query.capabilities(this, groupId, controllers); }

  // 私有聚合方法体已迁入共享模块;这里只保留转发,既有内部调用方(telemetry-overview 等)无需改动。
  _capabilitiesForHost(host) { return view._capabilitiesForHost(this, host); }
  _capabilityMap(host) { return view._capabilityMap(this, host); }
  _rows(groupId, from, to) { return batch._rows(this, groupId, from, to); }
  _loadTurn(kind, id) { return batch._loadTurn(this, kind, id); }
  _state(value) { return batch._state(value); }
  _actor(sender) { return batch._actor(this, sender); }
  _recipientActor(groupId, recipientId) { return batch._recipientActor(this, groupId, recipientId); }
  _managerOutgoingMessages(groupId, turnId) { return batch._managerOutgoingMessages(this, groupId, turnId); }
  _inputBatch(turn) { return batch._inputBatch(this, turn); }
  _metricFromTurn(rows, field) { return batch._metricFromTurn(rows, field); }
  _stepSum(rows, field) { return batch._stepSum(rows, field); }
  _buildMetrics(rows, host) { return batch._buildMetrics(this, rows, host); }
  _buildContext(rows, host) { return batch._buildContext(this, rows, host); }
  _buildBatch(turn, rows) { return batch._buildBatch(this, turn, rows); }
  _batches(groupId, options) { return batch._batches(this, groupId, options); }
  _sumBatches(batches) { return view._sumBatches(batches); }
  _latestContext(batches) { return view._latestContext(batches); }
  _managerEmptyContext() { return view._managerEmptyContext(); }
  _coverage(batches) { return view._coverage(batches); }
  _sessions(batches) { return view._sessions(this, batches); }
  _provenance(batches) { return view._provenance(batches); }
  _sourceSubtotals(batches) { return view._sourceSubtotals(this, batches); }
  _outgoingMessages(turn) { return view._outgoingMessages(this, turn); }
  _involvement(turn, outgoingMessages, groupId, memberId) { return view._involvement(this, turn, outgoingMessages, groupId, memberId); }
  _compareBatches(a, b) { return view._compareBatches(a, b); }
  _managerPage(batches, options) { return view._managerPage(batches, options); }
  _summary(batches) { return view._summary(this, batches); }
  _page(batches, options) { return view._page(batches, options); }
  _range(from, to) { return view._range(from, to); }
  _base(groupId) { return view._base(this, groupId); }
}

export { telemetryCapabilitiesFor } from './telemetry-capabilities.mjs';
export { METRIC_KEYS, CONTEXT_KEYS, UNIFIED_FIELDS } from './capability-contract.mjs';
