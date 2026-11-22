import type { VariantProps } from "class-variance-authority"
import type { ComputedRef, InjectionKey } from "vue"
import type { ContainerSize } from "@/components/ui/size"
import { cva } from "class-variance-authority"

export { default as Empty } from "./Empty.vue"
export { default as EmptyContent } from "./EmptyContent.vue"
export { default as EmptyDescription } from "./EmptyDescription.vue"
export { default as EmptyHeader } from "./EmptyHeader.vue"
export { default as EmptyMedia } from "./EmptyMedia.vue"
export { default as EmptyTitle } from "./EmptyTitle.vue"

export const EMPTY_SIZE_KEY: InjectionKey<ComputedRef<ContainerSize>> = Symbol("empty-size")

export const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "bg-muted text-foreground flex shrink-0 items-center justify-center rounded-(--component-chip-radius)",
      },
      size: {
        sm: "",
        md: "",
        lg: "",
      },
    },
    compoundVariants: [
      { variant: "icon", size: "sm", class: "size-8 [&_svg:not([class*='size-'])]:size-4" },
      { variant: "icon", size: "md", class: "size-10 [&_svg:not([class*='size-'])]:size-6" },
      { variant: "icon", size: "lg", class: "size-12 [&_svg:not([class*='size-'])]:size-7" },
    ],
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
)

export type EmptyMediaVariants = VariantProps<typeof emptyMediaVariants>
