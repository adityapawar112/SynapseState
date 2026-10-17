import * as React from "react";
import { cn } from "@/lib/utils";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?:
    | "default"
    | "active"
    | "nearExpiry"
    | "expired"
    | "revoked"
    | "promoted"
    | "compute"
    | "storage"
    | "ai"
    | "sase"
    | "outline";
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  let variantClass = "badge-expired";
  if (variant === "active") variantClass = "badge-active";
  else if (variant === "nearExpiry") variantClass = "badge-near-expiry";
  else if (variant === "revoked") variantClass = "badge-revoked";
  else if (variant === "promoted") variantClass = "badge-promoted";
  else if (variant === "compute") variantClass = "badge-compute";
  else if (variant === "storage") variantClass = "badge-storage";
  else if (variant === "ai") variantClass = "badge-ai";
  else if (variant === "sase") variantClass = "badge-sase";

  return <span className={cn("badge", variantClass, className)} {...props} />;
}
