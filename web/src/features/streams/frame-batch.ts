/**
 * 流层统一批帧入口。
 *
 * 实现复用 `@/features/messages/frame-batch`（早期三处重复的 frameBatch 已在
 * 该文件收口，此处只做流层目录下的稳定入口）。流层消费者一律从本模块引入，
 * 后续把实现迁进 streams/ 内部时无需再改调用方。
 */
export { frameBatch } from '@/features/messages/frame-batch';
