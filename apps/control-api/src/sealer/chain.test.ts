import { describe, it, expect } from "vitest";
import {
  GENESIS_PREV_HASH,
  canonicalizeAuditEvent,
  computeEventHash,
  verifySingleEvent,
  verifyAuditChain,
  type AuditEventRecord,
} from "./chain.js";

describe("Audit Ledger Chain Math & Verification (chain.ts)", () => {
  it("defines GENESIS_PREV_HASH as 64 zeros", () => {
    expect(GENESIS_PREV_HASH).toBe("0".repeat(64));
    expect(GENESIS_PREV_HASH.length).toBe(64);
  });

  it("canonicalizes audit event deterministically using RFC 8785", () => {
    const ts = "2026-10-11T12:00:00.000Z";
    const event1 = {
      seq: 1,
      ts,
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: { b: 2, a: 1, nested: { y: 20, x: 10 } },
    };

    const event2 = {
      actor: "sre-alice",
      payload: { nested: { x: 10, y: 20 }, a: 1, b: 2 },
      event_type: "LEASE_CREATED",
      ts,
      seq: 1,
    };

    const canonical1 = canonicalizeAuditEvent(event1);
    const canonical2 = canonicalizeAuditEvent(event2);

    expect(canonical1).toBe(canonical2);
    // Keys should be ordered and formatted canonically without extra whitespace
    expect(canonical1).toBe(
      JSON.stringify({
        actor: "sre-alice",
        event_type: "LEASE_CREATED",
        payload: { a: 1, b: 2, nested: { x: 10, y: 20 } },
        seq: 1,
        ts,
      })
    );
  });

  it("normalizes Date instances to ISO strings during canonicalization", () => {
    const date = new Date("2026-10-11T14:30:00.000Z");
    const eventWithDate = {
      seq: 1,
      ts: date,
      actor: "sre-bob",
      event_type: "LEASE_REVOKED",
      payload: { lease_id: "01J9X57Y" },
    };

    const eventWithString = {
      seq: 1,
      ts: date.toISOString(),
      actor: "sre-bob",
      event_type: "LEASE_REVOKED",
      payload: { lease_id: "01J9X57Y" },
    };

    expect(canonicalizeAuditEvent(eventWithDate)).toBe(
      canonicalizeAuditEvent(eventWithString)
    );
  });

  it("computes deterministic SHA-256 hash chaining formula", () => {
    const event = {
      seq: 1,
      ts: "2026-10-11T12:00:00.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: { flag_key: "checkout-v2" },
    };

    const hash1 = computeEventHash(GENESIS_PREV_HASH, event);
    const hash2 = computeEventHash(GENESIS_PREV_HASH, event);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);

    // Different prev_hash produces different hash
    const hashWithDifferentPrev = computeEventHash("1".repeat(64), event);
    expect(hashWithDifferentPrev).not.toBe(hash1);
  });

  it("verifies single audit event against expected prev_hash", () => {
    const event = {
      seq: 1,
      ts: "2026-10-11T12:00:00.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: { flag_key: "checkout-v2" },
    };

    const hash = computeEventHash(GENESIS_PREV_HASH, event);
    const record: AuditEventRecord = {
      ...event,
      prev_hash: GENESIS_PREV_HASH,
      hash,
    };

    expect(verifySingleEvent(record, GENESIS_PREV_HASH)).toBe(true);
    expect(verifySingleEvent(record, "f".repeat(64))).toBe(false);
  });

  it("verifies multi-event hash chain from genesis", () => {
    const events: AuditEventRecord[] = [];
    let prevHash = GENESIS_PREV_HASH;

    for (let i = 1; i <= 5; i++) {
      const eventData = {
        seq: i,
        ts: `2026-10-11T12:00:0${i}.000Z`,
        actor: `actor-${i}`,
        event_type: "LEASE_CREATED",
        payload: { index: i },
      };
      const hash = computeEventHash(prevHash, eventData);
      events.push({
        ...eventData,
        prev_hash: prevHash,
        hash,
      });
      prevHash = hash;
    }

    const verification = verifyAuditChain(events);
    expect(verification.valid).toBe(true);
    expect(verification.error).toBeUndefined();
  });

  it("detects payload tampering in the audit chain", () => {
    const events: AuditEventRecord[] = [];
    let prevHash = GENESIS_PREV_HASH;

    for (let i = 1; i <= 3; i++) {
      const eventData = {
        seq: i,
        ts: `2026-10-11T12:00:0${i}.000Z`,
        actor: `actor-${i}`,
        event_type: "LEASE_CREATED",
        payload: { index: i },
      };
      const hash = computeEventHash(prevHash, eventData);
      events.push({
        ...eventData,
        prev_hash: prevHash,
        hash,
      });
      prevHash = hash;
    }

    // Tamper with payload of event 2
    events[1] = {
      ...events[1]!,
      payload: { index: 2, tampered: true },
    };

    const verification = verifyAuditChain(events);
    expect(verification.valid).toBe(false);
    expect(verification.failedSeq).toBe(2);
    expect(verification.error).toContain("Hash mismatch");
  });

  it("detects sequence number mutation in the audit chain", () => {
    const events: AuditEventRecord[] = [];
    let prevHash = GENESIS_PREV_HASH;

    for (let i = 1; i <= 3; i++) {
      const eventData = {
        seq: i,
        ts: `2026-10-11T12:00:0${i}.000Z`,
        actor: `actor-${i}`,
        event_type: "LEASE_CREATED",
        payload: { index: i },
      };
      const hash = computeEventHash(prevHash, eventData);
      events.push({
        ...eventData,
        prev_hash: prevHash,
        hash,
      });
      prevHash = hash;
    }

    // Mutate seq of event 2 (e.g. skip to 4)
    events[1] = {
      ...events[1]!,
      seq: 4,
    };

    const verification = verifyAuditChain(events);
    expect(verification.valid).toBe(false);
    expect(verification.failedSeq).toBe(4);
  });

  it("detects timestamp mutation in the audit chain", () => {
    const events: AuditEventRecord[] = [];
    let prevHash = GENESIS_PREV_HASH;

    for (let i = 1; i <= 3; i++) {
      const eventData = {
        seq: i,
        ts: `2026-10-11T12:00:0${i}.000Z`,
        actor: `actor-${i}`,
        event_type: "LEASE_CREATED",
        payload: { index: i },
      };
      const hash = computeEventHash(prevHash, eventData);
      events.push({
        ...eventData,
        prev_hash: prevHash,
        hash,
      });
      prevHash = hash;
    }

    // Mutate timestamp of event 3
    events[2] = {
      ...events[2]!,
      ts: "2026-10-11T12:05:00.000Z",
    };

    const verification = verifyAuditChain(events);
    expect(verification.valid).toBe(false);
    expect(verification.failedSeq).toBe(3);
    expect(verification.error).toContain("Hash mismatch");
  });

  it("detects broken prev_hash link between consecutive blocks", () => {
    const events: AuditEventRecord[] = [];
    let prevHash = GENESIS_PREV_HASH;

    for (let i = 1; i <= 3; i++) {
      const eventData = {
        seq: i,
        ts: `2026-10-11T12:00:0${i}.000Z`,
        actor: `actor-${i}`,
        event_type: "LEASE_CREATED",
        payload: { index: i },
      };
      const hash = computeEventHash(prevHash, eventData);
      events.push({
        ...eventData,
        prev_hash: prevHash,
        hash,
      });
      prevHash = hash;
    }

    // Mutate prev_hash of event 3
    events[2] = {
      ...events[2]!,
      prev_hash: "0123456789abcdef".repeat(4),
    };

    const verification = verifyAuditChain(events);
    expect(verification.valid).toBe(false);
    expect(verification.failedSeq).toBe(3);
  });

  it("rejects non-genesis chain when first event has wrong prev_hash", () => {
    const eventData = {
      seq: 1,
      ts: "2026-10-11T12:00:00.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: {},
    };
    const hash = computeEventHash("bad_prev_hash".padEnd(64, "0"), eventData);
    const event: AuditEventRecord = {
      ...eventData,
      prev_hash: "bad_prev_hash".padEnd(64, "0"),
      hash,
    };

    const verification = verifyAuditChain([event]);
    expect(verification.valid).toBe(false);
    expect(verification.failedSeq).toBe(1);
    expect(verification.error).toContain("Genesis prev_hash must be 64 zeros");
  });
});
