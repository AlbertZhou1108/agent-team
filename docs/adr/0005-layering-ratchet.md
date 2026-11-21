# ADR 0005：测试分层 ratchet

- 状态：已采纳（2026-11-06，提交 284dfb8）
- 背景：contract 层有 57 处断言直读 store 内部行，规则只告警，形同虚设。
- 决策：`check-layering` 规则 A 改为 ratchet：存量基线（`scripts/layering-baseline.json`）以内告警，新增/超基线直接失败；迁移后 `--update-baseline` 下调；`LAYERING_STRICT_A=1` 为最终全量阻断。
- 后果：新违规被门禁拦下；存量 57 → 33 处，随拆分类继续下降。
