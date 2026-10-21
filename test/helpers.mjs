export const testContract = {
  goal: '完成指定测试任务', scope: '仅限独立测试目录', boundary: '不得修改其他项目或访问外部系统',
  confirmation: '范围、授权或目标变化需用户确认', delivery: '结果及证据', criteria: ['具有可验证的任务结果'], policy: 'communication',
};
export function confirmedGroup(bus, args, contract = testContract) {
  let p = bus.prepareGroup(args);
  p = bus.collaboration.propose(p.id, contract, p.revision);
  return bus.confirmPreparation(p.id, p.revision, p.hash);
}
