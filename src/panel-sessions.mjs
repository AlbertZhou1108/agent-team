// Panel 会话门面:保持 PanelSessions 公共 API 不变(方法名/顺序/签名/async 标记),
// 按职责委托到 src/panel/* 纯函数。面板域表访问统一走 src/aggregates/panel.mjs;
// bus.mjs 保持 `new PanelSessions(this)` 与纯转发不变。
import * as accessDomain from './panel/access.mjs';
import * as sessionDomain from './panel/session.mjs';
import * as stateDomain from './panel/state.mjs';
import * as toolsDomain from './panel/tools.mjs';
import * as turnsDomain from './panel/turns.mjs';
import * as interactionsDomain from './panel/interactions.mjs';
import * as updatesDomain from './panel/updates.mjs';

export class PanelSessions {
  constructor(bus) {
    this.bus = bus;
  }
  panelAccessValue(agent) { return accessDomain.panelAccessValue(agent); }
  panelWorkspace(value, access) { return accessDomain.panelWorkspace(this.bus, value, access); }
  requirePanelAccess(hostName, access) { return accessDomain.requirePanelAccess(this.bus, hostName, access); }
  panelAgent() { return sessionDomain.panelAgent(this.bus); }
  ensurePanelBindings() { return sessionDomain.ensurePanelBindings(this.bus); }
  panelTeamRelation(groupId) { return sessionDomain.panelTeamRelation(this.bus, groupId); }
  panelTeamViews() { return sessionDomain.panelTeamViews(this.bus); }
  withPanelAttachments(agentId, rows) { return stateDomain.withPanelAttachments(this.bus, agentId, rows); }
  panelAgentState(summary = false) { return stateDomain.panelAgentState(this.bus, summary); }
  panelBrowserState(summary = false) { return stateDomain.panelBrowserState(this.bus, summary); }
  panelMessagePage(options = {}) { return stateDomain.panelMessagePage(this.bus, options); }
  panelConversation(after = 0) { return stateDomain.panelConversation(this.bus, after); }
  async createPanelAgent(options) { return sessionDomain.createPanelAgent(this.bus, options); }
  async updatePanelAgent(options) { return sessionDomain.updatePanelAgent(this.bus, options); }
  createPanelTeam(agent, options) { return sessionDomain.createPanelTeam(this.bus, agent, options); }
  requirePanelMain(agentId, groupId) { return sessionDomain.requirePanelMain(this.bus, agentId, groupId); }
  panelTeamSnapshot(groupId) { return sessionDomain.panelTeamSnapshot(this.bus, groupId); }
  async panelTool(sessionId, key, name, args, provenance = {}) {
    return toolsDomain.panelTool(this.bus, sessionId, key, name, args, provenance);
  }
  async executePanelTool(session, panelAgent, name, args, origin) {
    return toolsDomain.executePanelTool(this.bus, session, panelAgent, name, args, origin);
  }
  panelInstructions(session, panelAgent, activeTeamId = null) {
    return sessionDomain.panelInstructions(this.bus, session, panelAgent, activeTeamId);
  }
  panelUpdate(row) { return updatesDomain.panelUpdate(row); }
  publishPanelUpdate(options) { return updatesDomain.publishPanelUpdate(this.bus, options); }
  async runPanelTurn(options) { return turnsDomain.runPanelTurn(this.bus, options); }
  panelRequestHash(text, attachmentIds) { return turnsDomain.panelRequestHash(text, attachmentIds); }
  isUniqueViolation(error) { return turnsDomain.isUniqueViolation(error); }
  replayPanelRequest(panelAgentId, request) { return turnsDomain.replayPanelRequest(this.bus, panelAgentId, request); }
  async panelPrivateTurn(options) { return turnsDomain.panelPrivateTurn(this.bus, options); }
  async stopPanel() { return turnsDomain.stopPanel(this.bus); }
  resolvePanelRuntime(turnId, reason) { return turnsDomain.resolvePanelRuntime(this.bus, turnId, reason); }
  panelInteractionAnchor(session, panelAgent, origin, text) {
    return interactionsDomain.panelInteractionAnchor(this.bus, session, panelAgent, origin, text);
  }
  requestPanelControllerAction(panelAgent, session, origin, action, groupId) {
    return interactionsDomain.requestPanelControllerAction(this.bus, panelAgent, session, origin, action, groupId);
  }
  requestPanelMemberModel(panelAgent, session, origin, group, text, args) {
    return interactionsDomain.requestPanelMemberModel(this.bus, panelAgent, session, origin, group, text, args);
  }
  enqueuePanelPrivateAnswer(agentId, text) {
    return turnsDomain.enqueuePanelPrivateAnswer(this.bus, agentId, text);
  }
  panelUnknown(groupId = null) { return stateDomain.panelUnknown(this.bus, groupId); }
}
