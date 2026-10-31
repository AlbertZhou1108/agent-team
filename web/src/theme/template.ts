/**
 * 主题样板文件(带注释的 JSONC,设置页「新增主题」弹窗可下载)。
 * 测试会把这份模板喂给解析器,保证下发的样板永远合法;修改时保持变量齐全。
 */
export const THEME_TEMPLATE_JSON = `// agent-team 主题包样板(允许 // 注释)
// 使用方法:
// 1. 分别填写 light(浅色)与 dark(深色)两组变量,两套都要填全;
// 2. 不要删除任何变量或缺键,否则上传会被拒绝;
// 3. 颜色支持 #hex、oklch()、hsl()、hwb()、lab()、lch()、rgb()、color() 写法,
//    出于安全考虑不支持 url()、var() 和嵌套函数;radius 只接受 px/rem/em/% 长度;
// 4. 保存为 .json 文件,在「新增主题」弹窗上传。hover/tint 等派生色由应用自动计算。
{
  "format": "agent-team-theme",
  "version": 1,
  // 主题名称:1-60 字,上传后显示在主题卡片上(与服务端已有主题同名会冲突)
  "name": "我的主题",

  // ======================= 浅色模式 =======================
  "light": {
    // 页面底色:消息流、团队主页、列表背后的整体底
    "background": "oklch(0.985 0.004 240)",
    // 正文文字:长文阅读,与 background 对比度建议 ≥ 7:1
    "foreground": "oklch(0.27 0.02 240)",
    // 卡片底色:消息卡、设置面板;侧栏也用它。与 background 拉开半档形成层次
    "card": "oklch(0.995 0.002 240)",
    // 卡片上的文字
    "card-foreground": "oklch(0.27 0.02 240)",
    // 浮层底色:下拉菜单、tooltip、气泡
    "popover": "oklch(0.995 0.002 240)",
    // 浮层上的文字
    "popover-foreground": "oklch(0.27 0.02 240)",
    // 品牌主色:主按钮、选中项高亮、tinted 气泡底;hover/tint 由它派生,是主题的性格色
    "primary": "oklch(0.52 0.1 245)",
    // 主色之上的文字(如主按钮文字),与 primary 对比度 ≥ 4.5:1
    "primary-foreground": "oklch(0.985 0.004 240)",
    // 次级填充:次级按钮、运行卡选中行
    "secondary": "oklch(0.955 0.01 235)",
    // 次级填充上的文字
    "secondary-foreground": "oklch(0.32 0.03 240)",
    // 悬停高亮底:列表悬停、菜单选中。必须与宿主底色可区分,否则悬停不可见
    "accent": "oklch(0.94 0.018 235)",
    // 悬停高亮上的文字
    "accent-foreground": "oklch(0.32 0.03 240)",
    // 弱化底色:代码块/引用底、表格斑马纹。建议主题色相的极低饱和版
    "muted": "oklch(0.955 0.01 235)",
    // 弱化文字:时间戳、占位符、说明文字;滚动条颜色由它派生
    "muted-foreground": "oklch(0.5 0.03 240)",
    // 危险色:删除确认按钮、错误提示
    "destructive": "oklch(0.58 0.21 27)",
    // 危险底色上的文字(实心按钮/徽标)
    "destructive-foreground": "oklch(0.985 0.004 240)",
    // 成功色:在线状态点、完成态
    "success": "oklch(0.63 0.17 150)",
    // 成功底色上的文字
    "success-foreground": "oklch(0.985 0.004 240)",
    // 警告色:重试/降级类提示
    "warning": "oklch(0.67 0.16 70)",
    // 警告底色上的文字
    "warning-foreground": "oklch(0.985 0.004 240)",
    // 信息色:中性信息提示;色相应与 primary 错开
    "info": "oklch(0.55 0.2 262)",
    // 信息底色上的文字
    "info-foreground": "oklch(0.985 0.004 240)",
    // 全局边框:卡片、分隔线。深色模式惯例可用白色低透明度(如 oklch(1 0 0 / 10%))
    "border": "oklch(0.9 0.012 235)",
    // 输入控件边框:通常比 border 深一档
    "input": "oklch(0.86 0.018 235)",
    // 焦点环颜色:键盘导航可见性全靠它
    "ring": "oklch(0.6 0.09 245)",
    // 代码块底色(终端风格块)
    "code": "oklch(0.22 0.02 245)",
    // 代码块文字
    "code-foreground": "oklch(0.9 0.015 235)",
    // 弹窗遮罩:压暗整页的半透明色
    "scrim": "oklch(0 0 0 / 65%)",
    // 圆角基值:派生 sm/md/lg/xl 四档
    "radius": "0.5rem"
  },

  // ======================= 深色模式 =======================
  "dark": {
    // 深色版取值建议:同色相、降明度做底、提亮文字;border/input 用白色低透明度
    "background": "oklch(0.18 0.015 245)",
    "foreground": "oklch(0.93 0.01 235)",
    "card": "oklch(0.22 0.018 245)",
    "card-foreground": "oklch(0.93 0.01 235)",
    "popover": "oklch(0.24 0.02 245)",
    "popover-foreground": "oklch(0.93 0.01 235)",
    // 深色下主色通常提亮一档,保证按钮对比
    "primary": "oklch(0.74 0.09 240)",
    "primary-foreground": "oklch(0.18 0.015 245)",
    "secondary": "oklch(0.28 0.02 245)",
    "secondary-foreground": "oklch(0.93 0.01 235)",
    "accent": "oklch(0.29 0.022 245)",
    "accent-foreground": "oklch(0.93 0.01 235)",
    "muted": "oklch(0.28 0.02 245)",
    // 深色下弱化文字别太暗(明度 ≥ 0.6),否则糊掉
    "muted-foreground": "oklch(0.68 0.025 240)",
    "destructive": "oklch(0.66 0.19 27)",
    // 深色下状态色更亮,配深色文字
    "destructive-foreground": "oklch(0.16 0.015 245)",
    "success": "oklch(0.72 0.17 150)",
    "success-foreground": "oklch(0.16 0.015 245)",
    "warning": "oklch(0.77 0.16 75)",
    "warning-foreground": "oklch(0.16 0.015 245)",
    "info": "oklch(0.68 0.12 250)",
    "info-foreground": "oklch(0.16 0.015 245)",
    "border": "oklch(1 0 0 / 12%)",
    "input": "oklch(1 0 0 / 16%)",
    "ring": "oklch(0.6 0.08 240)",
    "code": "oklch(0.15 0.018 248)",
    "code-foreground": "oklch(0.85 0.015 235)",
    "scrim": "oklch(0 0 0 / 70%)",
    "radius": "0.5rem"
  }
}
`;
