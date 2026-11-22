import type { ComputedRef, InjectionKey } from 'vue';

export type TabsVariant = 'pill' | 'underline';

export const TABS_VARIANT_KEY: InjectionKey<ComputedRef<TabsVariant>> =
  Symbol('tabs-variant');
