import type { PanelPreparation } from './types';

export function isPreparationApprovable(preparation: PanelPreparation) {
  const memberCount = preparation.spec.members.length;
  return Boolean(
    !preparation.group_id
    && preparation.contract
    && preparation.hash
    && (
      memberCount === 0
      || preparation.rolePlan?.roles.length === memberCount
    ),
  );
}
