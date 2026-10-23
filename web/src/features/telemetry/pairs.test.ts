import { describe, expect, it } from 'vitest';
import type { Member, SessionEndpoint } from '@/shared/api/raw-types';
import { buildConversationPairs, isPairEndpoint } from './pairs';

function member(
  id: string,
  name = id,
  removed: string | null = null,
): Member {
  return {
    id,
    group_id: 'group-1',
    name,
    host: 'dsh',
    role: 'member',
    profile: '',
    removed,
    model_provider: null,
    model: null,
    reasoning_effort: null,
  };
}

function endpoint(
  id: string,
  memberId: string,
  context: string,
): SessionEndpoint {
  return {
    id,
    group_id: 'group-1',
    member_id: memberId,
    context,
    peer: context.startsWith('pair:') ? context.slice('pair:'.length) : null,
    session: null,
    modelState: null as unknown as SessionEndpoint['modelState'],
  };
}

describe('buildConversationPairs', () => {
  it('keeps member-to-member pair endpoints and dedupes both sides', () => {
    const members = [member('a', '甲'), member('b', '乙')];
    const endpoints = [
      endpoint('e1', 'a', 'pair:b'),
      endpoint('e2', 'b', 'pair:a'),
    ];
    const pairs = buildConversationPairs(members, endpoints);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ key: 'a:b', memberId: 'a', peerId: 'b' });
    expect(pairs[0]!.label).toBe('甲 ↔ 乙');
  });

  it('excludes pair endpoints whose peer is the Panel Agent, not a group member', () => {
    const members = [member('a', '执行成员'), member('b', '审查成员')];
    const endpoints = [
      endpoint('e1', 'a', 'pair:panel-agent-id'),
      endpoint('e2', 'b', 'pair:panel-agent-id'),
    ];
    expect(buildConversationPairs(members, endpoints)).toEqual([]);
  });

  it('excludes pair endpoints involving a removed member', () => {
    const members = [member('a', '甲'), member('b', '乙', '2026-10-23T00:00:00.000Z')];
    const endpoints = [endpoint('e1', 'a', 'pair:b')];
    expect(buildConversationPairs(members, endpoints)).toEqual([]);
  });

  it('excludes members that belong to another group', () => {
    const members = [member('a', '甲'), { ...member('b', '乙'), group_id: 'group-2' }];
    const endpoints = [endpoint('e1', 'a', 'pair:b')];
    expect(buildConversationPairs(members, endpoints)).toEqual([]);
  });

  it('ignores non-pair contexts and missing peers', () => {
    const members = [member('a'), member('b')];
    const endpoints = [
      endpoint('e1', 'a', 'profile'),
      endpoint('e2', 'a', 'coordination'),
      endpoint('e3', 'a', 'pair'),
    ];
    expect(buildConversationPairs(members, endpoints)).toEqual([]);
  });

  it('does not depend on member order in the endpoint pair key', () => {
    const members = [member('b', '乙'), member('a', '甲')];
    const endpoints = [endpoint('e1', 'b', 'pair:a')];
    const pairs = buildConversationPairs(members, endpoints);
    expect(pairs[0]).toMatchObject({ memberId: 'a', peerId: 'b' });
  });
});

describe('isPairEndpoint', () => {
  it('matches pair and peer-qualified pair contexts only', () => {
    const pair = endpoint('e1', 'a', 'pair:b');
    const legacyPair = endpoint('e2', 'a', 'pair');
    const coordination = endpoint('e3', 'a', 'coordination');
    expect(isPairEndpoint(pair)).toBe(true);
    expect(isPairEndpoint(legacyPair)).toBe(true);
    expect(isPairEndpoint(coordination)).toBe(false);
  });
});
