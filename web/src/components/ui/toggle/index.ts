import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Toggle } from "./Toggle.vue"

export const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-(--component-control-radius) font-medium hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 outline-none transition-[color,background-color,border-color,box-shadow] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        xs: "h-(--component-control-xs-height) rounded-(--component-chip-radius) px-1.5 min-w-(--component-control-xs-height) text-(length:--component-control-xs-font-size) [&_svg:not([class*='size-'])]:size-3",
        sm: "h-(--component-control-sm-height) px-2 min-w-(--component-control-sm-height) text-(length:--component-control-sm-font-size) [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-(--component-control-height) px-2.5 min-w-(--component-control-height) text-(length:--component-control-font-size) [&_svg:not([class*='size-'])]:size-4",
        lg: "h-(--component-control-lg-height) px-3 min-w-(--component-control-lg-height) text-(length:--component-control-lg-font-size) [&_svg:not([class*='size-'])]:size-4.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
)

export type ToggleVariants = VariantProps<typeof toggleVariants>
