import React from "react";
import type { VariantDistribution } from "@/lib/types";

interface TelemetryChartProps {
  variants: VariantDistribution[];
  totalEvaluations: number;
  winningVariant?: string;
}

const VARIANT_COLORS = [
  "#38bdf8", // Sky blue
  "#10b981", // Emerald green
  "#a855f7", // Purple
  "#f59e0b", // Amber
  "#f43f5e", // Rose
  "#64748b", // Slate
];

export function TelemetryChart({
  variants,
  totalEvaluations,
  winningVariant,
}: TelemetryChartProps) {
  if (variants.length === 0 || totalEvaluations === 0) {
    return (
      <div style={{ padding: "12px 0", color: "var(--text-muted)", fontSize: "0.8125rem" }}>
        No telemetry evaluations recorded in window
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%" }}>
      {/* Stacked percentage bar */}
      <div
        style={{
          display: "flex",
          height: "10px",
          width: "100%",
          borderRadius: "9999px",
          overflow: "hidden",
          backgroundColor: "rgba(255, 255, 255, 0.05)",
        }}
      >
        {variants.map((v, idx) => {
          const color = VARIANT_COLORS[idx % VARIANT_COLORS.length];
          return (
            <div
              key={v.variant}
              style={{
                width: `${v.percentage}%`,
                backgroundColor: color,
                transition: "width 0.3s ease",
              }}
              title={`${v.variant}: ${v.percentage}% (${v.count.toLocaleString()} evals)`}
            />
          );
        })}
      </div>

      {/* Legend & counts */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "12px",
          fontSize: "0.8125rem",
        }}
      >
        {variants.map((v, idx) => {
          const color = VARIANT_COLORS[idx % VARIANT_COLORS.length];
          const isWinning = winningVariant === v.variant;

          return (
            <div
              key={v.variant}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "2px",
                  backgroundColor: color,
                }}
              />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: isWinning ? 700 : 500,
                  color: isWinning ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                {v.variant}
              </span>
              <span style={{ color: "var(--text-muted)" }}>
                {v.percentage}% ({v.count.toLocaleString()})
              </span>
              {isWinning && (
                <span
                  style={{
                    fontSize: "0.6875rem",
                    padding: "1px 6px",
                    borderRadius: "4px",
                    backgroundColor: "rgba(16, 185, 129, 0.2)",
                    color: "#34d399",
                    fontWeight: 600,
                  }}
                >
                  WINNING
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
