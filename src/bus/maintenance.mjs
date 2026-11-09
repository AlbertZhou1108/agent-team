// 后台维护定时器：附件的定期清理与历史保留。
//
// 单独成类是为了把「什么时候开、按什么顺序停」集中在一处。close() 必须先停表
// 再收尾——定时器如果在 store 关闭之后触发，会拿到已关闭的连接。
// 两个任务都是 best-effort：失败只记日志，不影响通信启动。

export class Maintenance {
  constructor(bus) {
    this.bus = bus;
    this.attachmentTimer = null;
    this.retentionTimer = null;
    this.retentionInterval = null;
  }

  start() {
    this.startAttachments();
    this.startRetention();
  }

  // 启动清一次（.part 全清），之后每小时一次。
  startAttachments() {
    try {
      this.bus.attachments.cleanup(new Date(), { partMaxAgeMs: 0 });
    } catch (error) {
      console.error('[attachments] 启动清理失败:', error.message);
    }
    this.attachmentTimer = setInterval(() => {
      try {
        this.bus.attachments.cleanup(new Date());
      } catch (error) {
        console.error('[attachments] 定期清理失败:', error.message);
      }
    }, 60 * 60 * 1000);
    this.attachmentTimer.unref?.();
  }

  // 历史保留：启动 1 分钟后跑一次，之后每 6 小时；异步启动，不阻塞服务。
  startRetention() {
    const run = () => {
      try {
        this.bus.store.pruneHistory({ retentionDays: 30 });
      } catch (error) {
        if (!this.bus.closing) console.error('[retention] 历史清理失败:', error.message);
      }
    };
    this.retentionTimer = setTimeout(run, 60 * 1000);
    this.retentionTimer.unref?.();
    this.retentionInterval = setInterval(run, 6 * 60 * 60 * 1000);
    this.retentionInterval.unref?.();
  }

  /** 停表。必须在 bus.close() 的最前面调用。 */
  stop() {
    if (this.attachmentTimer) {
      clearInterval(this.attachmentTimer);
      this.attachmentTimer = null;
    }
    if (this.retentionTimer) {
      clearTimeout(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.retentionInterval) {
      clearInterval(this.retentionInterval);
      this.retentionInterval = null;
    }
  }
}
