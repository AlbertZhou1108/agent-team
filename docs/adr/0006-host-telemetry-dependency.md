# ADR 0006：宿主与遥测的依赖方向

- 状态：已采纳（2026-11-06，提交 acdfa44）
- 背景：宿主适配器 import 遥测实现（`../telemetry.mjs`），framework 与 adapter 方向倒置；能力表集中在遥测侧。
- 决策：能力声明下放到各适配器（`codexCapabilities` / `claudeCapabilities` / `dshCapabilities`）；观测载荷构造抽到中性 `src/observation.mjs`；能力契约抽到 `src/capability-contract.mjs`；遥测核心不再查宿主表。
- 后果：`grep "from '../telemetry" src/hosts/` 为 0；新增宿主只需实现能力声明，不再改遥测模块。
