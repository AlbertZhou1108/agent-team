import type { ComputedRef, InjectionKey } from 'vue';
import type { ControlSize } from '@/components/ui/size';

export type TabsVariant = 'pill' | 'underline';

export const TABS_VARIANT_KEY: InjectionKey<ComputedRef<TabsVariant>> =
  Symbol('tabs-variant');

export const TABS_SIZE_KEY: InjectionKey<ComputedRef<ControlSize>> =
  Symbol('tabs-size');
