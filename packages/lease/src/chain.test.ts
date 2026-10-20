import { describe, it, expect } from "vitest";
import {
  GENESIS_PREV_HASH,
  canonicalizeAuditEvent,
  computeEventHash,
  verifySingleEvent,
  verifyAuditChain,
  type AuditEventRecord,
} from "./chain.js";

describe("Audit Ledger Chain Math & Verification (packages/lease/src/chain.ts)", () => {
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
    expect(canonical1).toBe(
      JSON.stringify({
        actor: "sre-alice",
        event_type: "LEASE_CREATED",
        payload: { a: 1, b: 2, nested: { x: 10, y: 20 } },
        seq: 1,
        ts,
      }),
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
    expect(computeEventHash("1".repeat(64), event)).not.toBe(hash1);
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
    expect(verification.error).toContain("Hash mismatch at seq 2");
  });

  it("detects sequence number discontinuity and reports missing expectedSeq (I7)", () => {
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

    // Mutate seq of event 2 to 4 (missing seq 2)
    events[1] = {
      ...events[1]!,
      seq: 4,
    };

    const verification = verifyAuditChain(events);
    expect(verification.valid).toBe(false);
    expect(verification.failedSeq).toBe(2);
    expect(verification.error).toContain("expected seq 2, got 4");
  });

  it("detects prefix truncation when chain starts at seq > 1 from genesis (C1)", () => {
    const originalEvents: AuditEventRecord[] = [];
    let prevHash = GENESIS_PREV_HASH;
    for (let i = 1; i <= 10; i++) {
      const eventData = {
        seq: i,
        ts: `2026-10-11T12:00:${i < 10 ? "0" + i : i}.000Z`,
        actor: `actor-${i}`,
        event_type: "LEASE_CREATED",
        payload: { index: i },
      };
      const hash = computeEventHash(prevHash, eventData);
      originalEvents.push({
        ...eventData,
        prev_hash: prevHash,
        hash,
      });
      prevHash = hash;
    }

    // Attacker drops seq 1..5, re-hashes from seq 6 using GENESIS_PREV_HASH
    const truncated: AuditEventRecord[] = [];
    let forgedPrev = GENESIS_PREV_HASH;
    for (let i = 5; i < 10; i++) {
      const original = originalEvents[i]!;
      const forgedHash = computeEventHash(forgedPrev, original);
      truncated.push({
        ...original,
        prev_hash: forgedPrev,
        hash: forgedHash,
      });
      forgedPrev = forgedHash;
    }

    expect(truncated[0]!.seq).toBe(6);
    expect(truncated[0]!.prev_hash).toBe(GENESIS_PREV_HASH);

    const verification = verifyAuditChain(truncated);
    expect(verification.valid).toBe(false);
    expect(verification.failedSeq).toBe(6);
    expect(verification.error).toContain(
      "Ledger does not start at genesis: first seq is 6, expected 1 (possible prefix truncation)",
    );

    // Permitted with explicit requireGenesisStart: false
    const partialVerification = verifyAuditChain(truncated, GENESIS_PREV_HASH, {
      requireGenesisStart: false,
    });
    expect(partialVerification.valid).toBe(true);
  });

  it("handles empty event lists in verifyAuditChain", () => {
    expect(verifyAuditChain([])).toEqual({ valid: true });
  });

  it("rejects single event with tampered hash even if prev_hash matches", () => {
    const event = {
      seq: 1,
      ts: "2026-10-11T12:00:00.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: { flag_key: "checkout-v2" },
    };
    const validHash = computeEventHash(GENESIS_PREV_HASH, event);
    const tamperedRecord: AuditEventRecord = {
      ...event,
      prev_hash: GENESIS_PREV_HASH,
      hash: "0".repeat(63) + "1",
    };
    expect(verifySingleEvent(tamperedRecord, GENESIS_PREV_HASH)).toBe(false);
  });

  it("rejects genesis sequence 1 when initialPrevHash is not 64 zeros", () => {
    const event = {
      seq: 1,
      ts: "2026-10-11T12:00:00.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: {},
      prev_hash: "a".repeat(64),
      hash: "b".repeat(64),
    };
    const result = verifyAuditChain([event], "a".repeat(64), { requireGenesisStart: false });
    expect(result.valid).toBe(false);
    expect(result.failedSeq).toBe(1);
    expect(result.error).toBe(`Genesis prev_hash must be 64 zeros, got: "${"a".repeat(64)}"`);
  });

  it("formats broken prev_hash error messages specifically for seq 1 and seq > 1", () => {
    const event1BadPrev: AuditEventRecord = {
      seq: 1,
      ts: "2026-10-11T12:00:00.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: {},
      prev_hash: "wrong-prev".padEnd(64, "0"),
      hash: "some-hash".padEnd(64, "0"),
    };
    const res1 = verifyAuditChain([event1BadPrev]);
    expect(res1.valid).toBe(false);
    expect(res1.error).toBe(`Genesis prev_hash must be 64 zeros, got: "${event1BadPrev.prev_hash}"`);

    const valid1 = {
      seq: 1,
      ts: "2026-10-11T12:00:00.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: {},
    };
    const hash1 = computeEventHash(GENESIS_PREV_HASH, valid1);
    const rec1: AuditEventRecord = { ...valid1, prev_hash: GENESIS_PREV_HASH, hash: hash1 };

    const rec2BadPrev: AuditEventRecord = {
      seq: 2,
      ts: "2026-10-11T12:00:01.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: {},
      prev_hash: "wrong-link".padEnd(64, "0"),
      hash: "some-hash".padEnd(64, "0"),
    };

    const res2 = verifyAuditChain([rec1, rec2BadPrev]);
    expect(res2.valid).toBe(false);
    expect(res2.failedSeq).toBe(2);
    expect(res2.error).toBe(`Broken prev_hash link at seq 2: expected "${hash1}", got "${rec2BadPrev.prev_hash}"`);
  });

  it("handles non-Date and non-parseable timestamps in canonicalizeAuditEvent", () => {
    const d = new Date("2026-10-11T12:00:00.000Z");
    const c1 = canonicalizeAuditEvent({ seq: 1, ts: d, actor: "a", event_type: "e", payload: {} });
    const c2 = canonicalizeAuditEvent({ seq: 1, ts: "2026-10-11T12:00:00.000Z", actor: "a", event_type: "e", payload: {} });
    expect(c1).toBe(c2);

    const c3 = canonicalizeAuditEvent({ seq: 1, ts: "invalid-date", actor: "a", event_type: "e", payload: {} });
    expect(c3).toContain('"ts":"invalid-date"');
  });

  it("verifies mid-chain segment starting from non-genesis hash when requireGenesisStart is false", () => {
    const valid1 = {
      seq: 1,
      ts: "2026-10-11T12:00:00.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: {},
    };
    const hash1 = computeEventHash(GENESIS_PREV_HASH, valid1);

    const valid2 = {
      seq: 2,
      ts: "2026-10-11T12:00:01.000Z",
      actor: "sre-alice",
      event_type: "LEASE_CREATED",
      payload: {},
    };
    const hash2 = computeEventHash(hash1, valid2);
    const rec2: AuditEventRecord = { ...valid2, prev_hash: hash1, hash: hash2 };

    // Valid mid-chain segment starting at seq 2 with initialPrevHash = hash1
    const res = verifyAuditChain([rec2], hash1, { requireGenesisStart: false });
    expect(res.valid).toBe(true);

    // If requireGenesisStart is true (default) but initialPrevHash is NOT genesis,
    // it allows mid-chain slice because initialPrevHash !== GENESIS_PREV_HASH
    const res2 = verifyAuditChain([rec2], hash1);
    expect(res2.valid).toBe(true);
  });
});
