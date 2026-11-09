// Bus 的门面入口：实现搬进 bus/ 子目录，这里只为保住 100+ 个 './bus.mjs' 的既有引用。
// 目录重排时再一起抹掉这层接缝。
export { Bus, interactionView } from './bus/index.mjs';
