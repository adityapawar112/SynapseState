import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "brand" | "secondary" | "destructive" | "ghost" | "link";
  size?: "default" | "sm" | "lg" | "pill";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "default", ...props }, ref) => {
    let variantClass = "btn-secondary";
    if (variant === "default") {
      variantClass = "btn-pill-cream";
    } else if (variant === "brand") {
      variantClass = "btn-pill-brand";
    } else if (variant === "destructive") {
      variantClass = "btn-danger";
    } else if (variant === "ghost") {
      variantClass = "btn";
    }

    let sizeStyle: React.CSSProperties = {};
    if (size === "sm") {
      sizeStyle = { height: "32px", padding: "4px 10px", fontSize: "13px" };
    } else if (size === "pill" || size === "lg") {
      sizeStyle = { height: "46px", padding: "12px 24px", borderRadius: "var(--radius-full)" };
    }

    return (
      <button
        ref={ref}
        className={cn("btn", variantClass, className)}
        style={{ ...sizeStyle, ...(props.style || {}) }}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";
