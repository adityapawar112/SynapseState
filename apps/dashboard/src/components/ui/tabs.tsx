import * as React from "react";
import { cn } from "@/lib/utils";

export type TabsListProps = React.HTMLAttributes<HTMLDivElement>;

export function TabsList({ className, style, ...props }: TabsListProps) {
  return (
    <div
      className={cn("flex items-center gap-2", className)}
      style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", ...style }}
      {...props}
    />
  );
}

export interface TabTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function TabTrigger({ active, className, ...props }: TabTriggerProps) {
  return (
    <button
      type="button"
      className={cn("category-tab", active && "category-tab-active", className)}
      {...props}
    />
  );
}
