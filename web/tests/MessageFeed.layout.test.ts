import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import MessageFeed from '@/features/messages/MessageFeed.vue';
vi.mock('@/components/ai-elements/ConversationScroller.vue',()=>({default:defineComponent({setup:(_props,{slots})=>()=>h('div',[slots['bar-top']?.(),slots.default?.(),h('div',{'data-sticky-bottom':true},slots['bar-bottom']?.())])})}));
vi.mock('@/components/ai-elements/RunStatusCard.vue',()=>({default:defineComponent({setup:()=>()=>h('aside',{'data-testid':'run-status-card'},'成员运行状态')})}));
describe('conversation bottom bar',()=>{
 it('places run status before the composer in the same bottom bar',async()=>{
  const html=await renderToString(createSSRApp({render:()=>h(MessageFeed,{messages:[],selectedPair:''},{'bar-bottom':()=>h('textarea',{'aria-label':'消息输入框'})})}));
  const bar=html.indexOf('data-sticky-bottom');
  const status=html.indexOf('data-testid="run-status-card"');
  const composer=html.indexOf('aria-label="消息输入框"');
  expect(status).toBeGreaterThan(bar);
  expect(composer).toBeGreaterThan(status);
  expect(html.match(/data-testid="run-status-card"/g)).toHaveLength(1);
 });
});
