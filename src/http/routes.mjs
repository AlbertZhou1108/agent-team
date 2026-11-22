import { teamsRoutes } from './routes/teams.mjs';
import { panelRoutes } from './routes/panel.mjs';
import { notesRoutes } from './routes/notes.mjs';
import { desktopRoutes } from './routes/desktop.mjs';
import { settingsRoutes } from './routes/settings.mjs';
import { telemetryRoutes } from './routes/telemetry.mjs';

// Each declaration owns matching, allowed methods, archived access and dispatch.
// 路由按业务子域拆分到 ./routes/ 下六个模块,本函数按固定顺序汇总;数组顺序即
// 匹配优先级(先命中先用),因此各子域内的既有先后顺序(notes prompt 路由、
// telemetry overview 路由等)必须保持不变。
export function apiRoutes(context) {
    return [
        ...teamsRoutes(context),
        ...panelRoutes(context),
        ...notesRoutes(context),
        ...desktopRoutes(context),
        ...settingsRoutes(context),
        ...telemetryRoutes(context),
    ];
}
