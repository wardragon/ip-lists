function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    throw new Error("Use an IPv4 address or CIDR, e.g. 10.0.0.1 or 10.0.0.0/8");
  }
  const octets = parts.map((p) => {
    if (!/^\d+$/.test(p)) throw new Error(`Invalid IPv4 octet: ${p}`);
    const n = Number(p);
    if (n < 0 || n > 255) throw new Error(`Invalid IPv4 octet: ${p}`);
    return n;
  });
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function intToIpv4(n) {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");
}

function rangesOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

function parseCidr(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Enter an IPv4 address or CIDR");

  const [ipPart, prefixPart] = raw.split("/");
  const prefix = prefixPart === undefined ? 32 : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error("CIDR prefix must be an integer from 0 to 32");
  }

  const addr = ipv4ToInt(ipPart);
  const hostBits = 32 - prefix;
  const size = hostBits === 32 ? 2 ** 32 : 2 ** hostBits;
  const mask = prefix === 0 ? 0 : ((0xffffffff << hostBits) >>> 0);
  const start = (addr & mask) >>> 0;
  const end = (start + size - 1) >>> 0;
  const cidr = `${intToIpv4(start)}/${prefix}`;

  return { cidr, start, end, prefix };
}

function findOverlap(candidate, others) {
  return others.find((entry) => rangesOverlap(candidate, entry)) || null;
}

module.exports = { parseCidr, rangesOverlap, findOverlap, ipv4ToInt, intToIpv4 };
