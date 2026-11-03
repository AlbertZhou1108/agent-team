/**
 * @typedef {Object} ModelSelection
 * @property {string | null} [model_provider]
 * @property {string | null} [model]
 * @property {string | null} [reasoning_effort]
 */

/**
 * 成员/Panel 回合的宿主调用参数。各适配器的 run() 接收同一形状。
 * @typedef {Object} HostRunOptions
 * @property {object} endpoint
 * @property {string} turnId
 * @property {string | null} workspace
 * @property {string} prompt
 * @property {string} instructions
 * @property {string[]} tools
 * @property {{ mode: string, allowShell: boolean, domain: string }} policy
 * @property {{ signature: string } | null} [previousPolicy]
 * @property {AbortSignal} signal
 * @property {ModelSelection} modelSelection
 * @property {() => void} [onAccepted]
 * @property {(ref: unknown) => void} [onNativeTurn]
 * @property {(name: string, args: object, metadata?: object) => Promise<object>} [onTool]
 * @property {(session: string) => void} [onSession]
 * @property {(observation: object) => void} [onModel]
 * @property {(selection: object) => void} [onSelection]
 * @property {(payload: object) => void} [onToolCallDelta]
 * @property {(delta: string) => void} [onTextDelta]
 * @property {(delta: string, metadata?: object) => void} [onReasoningDelta]
 * @property {(observation: object) => void} [onPolicy]
 * @property {(observation: object) => any} [onTelemetry]
 * @property {(event: object) => void} [onEvent]
 */

/** @typedef {{ policy: object, endpoint: object, member: object }} SessionKeyArgs */

/**
 * 宿主适配器接口。宿主由 loadHosts 按配置创建,run 发起一个执行回合。
 * @typedef {Object} HostAdapter
 * @property {(options: HostRunOptions) => Promise<string>} run
 * @property {() => void | Promise<void>} [close]
 * @property {(options: object) => { supported: boolean, reason?: string }} [supportsPanelAccess]
 * @property {(options: object) => { supported: boolean, reason?: string }} [supportsPolicy]
 * @property {() => Promise<object>} [listModels]
 * @property {() => object} [telemetryCapabilities]
 * @property {(args: SessionKeyArgs) => string} [sessionKey]
 */

/**
 * IPC 请求。op 决定其余字段;server.mjs 的 handleRpc 逐一消费。
 * @typedef {Object} RpcRequest
 * @property {string} op
 * @property {string} [socket]
 * @property {string} [endpoint]
 * @property {string} [key]
 * @property {string} [turnId]
 * @property {string} [group]
 * @property {string} [member]
 * @property {string} [text]
 * @property {object} [args]
 * @property {boolean} [refresh]
 * @property {string} [reason]
 * @property {string} [turn]
 */

/**
 * 职责模块可见的 Bus 协调面。各模块构造函数接收该引用;
 * 方法签名与 Bus 上的同名委托保持一致,新增交叉调用时同步维护。
 * @typedef {Object} BusRef
 * 
 * @property {StoreRef} store
 * @property {number} [panelBootSeq]
 * @property {(event: string, payload: object) => boolean} emit
 * @property {() => void} pump
 * @property {boolean} closing
 * @property {(id: string, answer: Record<string, any> | null | undefined) => Promise<unknown>} decideInteraction
 * @property {(row: Record<string, any>, payload: Record<string, any>, answer: Record<string, any> | null | undefined) => Promise<unknown>} decideActionInteraction
 * @property {(row: Record<string, any>, deliver: (text: string) => unknown, text: string) => void} deliverOutcomeSafe
 * @property {(row: object, text: string) => void} deliverToPanelPrivate
 * @property {(member: Record<string, any>, text: string) => Record<string, any>} memberInteractionAnchor
 * @property {(groupId: string, expectedRevision?: number) => Promise<unknown>} takeoverTeam
 * @property {(groupId: string, expectedRevision?: number) => Promise<unknown>} handbackTeam
 * @property {(args: object) => object} createGroup
 * @property {(groupId: string, args: object) => Promise<object>} addMember
 * @property {(groupId: string, memberId: string, selection: Record<string, any> | null) => Record<string, any>} applyMemberModel
 * @property {(groupId: string, options?: { archivedOnly?: boolean }) => Promise<{ deleted: string, cleanupWarnings?: string[] }>} deleteGroup
 */

/**
 * 职责模块可见的存储面。方法存在性受检查;行数据保持宽松以免重建整库类型。
 * @typedef {Object} StoreRef
 * @property {(sql: string, ...params: any[]) => any} get
 * @property {(sql: string, ...params: any[]) => any[]} all
 * @property {(sql: string, ...params: any[]) => { changes: number }} run
 * @property {<T>(fn: () => T) => T} transaction
 * @property {(id: string) => Record<string, any> | undefined} interaction
 * @property {(input: object) => Record<string, any>} createInteraction
 * @property {(id: string, state: string, answer?: Record<string, any> | null, messageId?: string | null, detail?: string | null) => void} setInteractionState
 * @property {(groupId: string, sender: string, recipient: string, kind: string, text: string, replyTo?: string | null, expectsReply?: boolean) => Record<string, any>} append
 */
