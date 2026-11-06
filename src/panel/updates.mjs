// Panel 更新:面板更新的读取投影与追加发布。接收 bus;
// 更新台账的 SQL 收在 aggregates/panel.mjs。
import { randomUUID } from 'node:crypto';
import * as panelAgg from '../aggregates/panel.mjs';

/** 面板更新行投影:kind 缺省 update,source_message_ids 反序列化为数组。 */
export function panelUpdate(row) {
  if (!row) return null;
  return {
    ...row,
    kind: row.kind ?? 'update',
    sourceMessageIds: JSON.parse(row.source_message_ids),
  };
}

/** 追加一条面板更新并广播 panel-update 事件;只追加不修改。 */
export function publishPanelUpdate(bus, {
  panelAgentId,
  groupId,
  sourceTurnId,
  kind = 'update',
  text,
  sourceMessageIds = [],
  id = randomUUID(),
}) {
  panelAgg.insertUpdate(bus.store, {
    id,
    panelAgentId,
    groupId,
    sourceTurnId,
    kind,
    text,
    sourceMessageIds,
    created: new Date().toISOString(),
  });
  const update = bus.panelUpdate(panelAgg.updateById(bus.store, id));
  bus.emit('panel-update', update);
  return update;
}
