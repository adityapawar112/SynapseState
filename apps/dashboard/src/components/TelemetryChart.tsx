import React from "react";
import type { VariantDistribution } from "@/lib/types";

interface TelemetryChartProps {
  variants: VariantDistribution[];
  totalEvaluations: number;
  winningVariant?: string;
}

const DOMAIN_VARIANT_COLORS = [
  "var(--color-kumo-brand)", // Voltage Orange
  "var(--color-compute)",    // Compute Blue
  "var(--color-ai)",         // AI Green
  "var(--color-storage)",    // Storage Pink
  "var(--color-sase)",       // SASE Teal
  "var(--color-ink-soft)",   // Charcoal
];

export function TelemetryChart({
  variants,
  totalEvaluations,
  winningVariant,
}: TelemetryChartProps) {
  if (variants.length === 0 || totalEvaluations === 0) {
    return (
      <div style={{ padding: "12px 0", color: "var(--color-muted)", fontSize: "13px", fontFamily: "var(--font-sans)" }}>
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
          height: "8px",
          width: "100%",
          borderRadius: "var(--radius-full)",
          overflow: "hidden",
          backgroundColor: "var(--color-hairline)",
        }}
      >
        {variants.map((v, idx) => {
          const color = DOMAIN_VARIANT_COLORS[idx % DOMAIN_VARIANT_COLORS.length];
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
          fontSize: "13px",
        }}
      >
        {variants.map((v, idx) => {
          const color = DOMAIN_VARIANT_COLORS[idx % DOMAIN_VARIANT_COLORS.length];
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
                  fontWeight: isWinning ? 600 : 400,
                  color: isWinning ? "var(--color-ink)" : "var(--color-ink-soft)",
                }}
              >
                {v.variant}
              </span>
              <span style={{ color: "var(--color-muted)", fontSize: "12px" }}>
                {v.percentage}% ({v.count.toLocaleString()})
              </span>
              {isWinning && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "10px",
                    padding: "2px 8px",
                    borderRadius: "var(--radius-full)",
                    backgroundColor: "var(--color-ai)",
                    color: "#ffffff",
                    fontWeight: 600,
                    letterSpacing: "0.05em",
                  }}
                >
                  STABLE
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
