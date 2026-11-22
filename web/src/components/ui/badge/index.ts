import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Badge } from "./Badge.vue"

export const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border font-medium w-fit whitespace-nowrap shrink-0 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        success:
          "border-transparent bg-success/15 text-success [a&]:hover:bg-success/25",
        warning:
          "border-transparent bg-warning/15 text-warning [a&]:hover:bg-warning/25",
        info:
          "border-transparent bg-info/15 text-info [a&]:hover:bg-info/25",
        destructive:
         "border-transparent bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
      },
      size: {
        xs: "px-1.5 py-0 text-2xs [&>svg]:size-2.5",
        sm: "px-1.5 py-0 text-(length:--component-control-sm-font-size) [&>svg]:size-3",
        md: "px-2 py-0.5 text-(length:--component-control-sm-font-size) [&>svg]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
