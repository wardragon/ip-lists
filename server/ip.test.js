const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseCidr, rangesOverlap, findOverlap } = require("./ip");

describe("parseCidr", () => {
  it("normalizes a host to /32", () => {
    const parsed = parseCidr("10.1.2.3");
    assert.equal(parsed.cidr, "10.1.2.3/32");
    assert.equal(parsed.start, parsed.end);
  });

  it("aligns a network to the prefix", () => {
    const parsed = parseCidr("10.1.2.3/8");
    assert.equal(parsed.cidr, "10.0.0.0/8");
  });
});

describe("exclusivity", () => {
  it("rejects the same IP on the other list", () => {
    const candidate = parseCidr("192.0.2.10");
    const conflict = findOverlap(candidate, [parseCidr("192.0.2.10")]);
    assert.ok(conflict);
  });

  it("rejects a host that sits inside a denied CIDR", () => {
    const candidate = parseCidr("10.9.8.7");
    const conflict = findOverlap(candidate, [{ ...parseCidr("10.0.0.0/8"), id: 1 }]);
    assert.equal(conflict.id, 1);
  });

  it("allows disjoint ranges", () => {
    const candidate = parseCidr("192.168.0.0/16");
    const conflict = findOverlap(candidate, [parseCidr("10.0.0.0/8")]);
    assert.equal(conflict, null);
  });

  it("detects overlapping CIDRs", () => {
    assert.equal(rangesOverlap(parseCidr("10.0.0.0/8"), parseCidr("10.1.0.0/16")), true);
  });
});
