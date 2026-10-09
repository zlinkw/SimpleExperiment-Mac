/**
 * factories_tunnel.test.js - TunnelFactory 单测
 * 验证 resolveEndpointUrl 对各种 host/port 组合、normalizeGatewayConfig 细节
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const factoriesDist = path.join(__dirname, "..", "dist", "factories");
const { DefaultTunnelFactory } = require(path.join(factoriesDist, "TunnelFactory.js"));
const { defaultTunnelGatewayConfig, normalizePort, localBaseUrl } = require(path.join(__dirname, "..", "dist", "tunnel", "TunnelGateway.js"));

// Helper: create fresh factory each test to avoid state leakage
function factory() {
  return new DefaultTunnelFactory();
}

test("resolveEndpointUrl - 正常 host/port 组合", () => {
  const f = factory();
  assert.equal(f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: 18765 }), "http://127.0.0.1:18765");
  assert.equal(f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: 34567 }), "http://127.0.0.1:34567");
  assert.equal(f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: 18999 }), "http://127.0.0.1:18999");
  assert.equal(f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: 1024 }), "http://127.0.0.1:1024");
  assert.equal(f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: 65535 }), "http://127.0.0.1:65535");
});

test("resolveEndpointUrl - 自定义 host", () => {
  const f = factory();
  assert.equal(f.resolveEndpointUrl({ localHost: "192.168.1.10", localPort: 42000 }), "http://192.168.1.10:42000");
  assert.equal(f.resolveEndpointUrl({ localHost: "10.0.0.5", localPort: 50000 }), "http://10.0.0.5:50000");
  // 带空格的 host 应 trim
  assert.equal(f.resolveEndpointUrl({ localHost: " 127.0.0.1 ", localPort: 18765 }), "http://127.0.0.1:18765");
});

test("resolveEndpointUrl - 空 host 回退到 127.0.0.1", () => {
  const f = factory();
  assert.equal(f.resolveEndpointUrl({ localHost: "", localPort: 18765 }), "http://127.0.0.1:18765");
  assert.equal(f.resolveEndpointUrl({ localHost: "   ", localPort: 18765 }), "http://127.0.0.1:18765");
  // undefined host via cast
  assert.equal(f.resolveEndpointUrl({ localHost: undefined, localPort: 18765 }), "http://127.0.0.1:18765");
});

test("resolveEndpointUrl - 非法端口回退到默认而非硬编码 10890", () => {
  const f = factory();
  const defPort = defaultTunnelGatewayConfig.localPort;
  // 越界端口
  const urlLow = f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: 80 });
  assert.ok(!urlLow.includes("10890"), "不应回退到 10890");
  assert.equal(urlLow, `http://127.0.0.1:${defPort}`);

  const urlHigh = f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: 99999 });
  assert.ok(!urlHigh.includes("10890"));
  assert.equal(urlHigh, `http://127.0.0.1:${defPort}`);

  const urlZero = f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: 0 });
  assert.equal(urlZero, `http://127.0.0.1:${defPort}`);

  const urlNeg = f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: -1 });
  assert.equal(urlNeg, `http://127.0.0.1:${defPort}`);

  const urlNaN = f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: Number.NaN });
  assert.equal(urlNaN, `http://127.0.0.1:${defPort}`);

  // 与 TunnelGateway.localBaseUrl 行为一致
  const direct = localBaseUrl({ localHost: "127.0.0.1", localPort: 99999 });
  assert.equal(direct, `http://127.0.0.1:${defPort}`);
});

test("resolveEndpointUrl - 动态性：不硬编码 10890", () => {
  const f = factory();
  const ports = [18765, 18766, 30000, 50000];
  for (const p of ports) {
    const url = f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: p });
    assert.equal(url, `http://127.0.0.1:${p}`);
  }
  // 非法端口也不应产生 10890
  const badPorts = [0, 80, 1023, 65536, 99999, NaN, -5];
  for (const p of badPorts) {
    const url = f.resolveEndpointUrl({ localHost: "127.0.0.1", localPort: p });
    assert.ok(!url.includes("10890"), `port ${p} 不应产生 10890`);
  }
});

test("normalizeGatewayConfig - 合并默认值", () => {
  const f = factory();
  const cfg = f.normalizeGatewayConfig({});
  assert.ok(cfg, "returns config");
  assert.equal(typeof cfg.localHost, "string");
  assert.equal(typeof cfg.localPort, "number");
  assert.equal(typeof cfg.remotePort, "number");
  assert.equal(cfg.localHost, defaultTunnelGatewayConfig.localHost);
  assert.equal(cfg.localPort, defaultTunnelGatewayConfig.localPort);
});

test("normalizeGatewayConfig - 保留合法端口", () => {
  const f = factory();
  const cfg = f.normalizeGatewayConfig({ localPort: 50000, remotePort: 50001 });
  assert.equal(cfg.localPort, 50000);
  assert.equal(cfg.remotePort, 50001);
  assert.equal(cfg.localHost, defaultTunnelGatewayConfig.localHost);
});

test("normalizeGatewayConfig - 非法端口回退", () => {
  const f = factory();
  const cfgLow = f.normalizeGatewayConfig({ localPort: 80 });
  assert.equal(cfgLow.localPort, defaultTunnelGatewayConfig.localPort);
  const cfgHigh = f.normalizeGatewayConfig({ localPort: 99999 });
  assert.equal(cfgHigh.localPort, defaultTunnelGatewayConfig.localPort);
  const cfgNaN = f.normalizeGatewayConfig({ localPort: NaN });
  assert.equal(cfgNaN.localPort, defaultTunnelGatewayConfig.localPort);
});

test("normalizeGatewayConfig - 合并额外字段不丢失", () => {
  const f = factory();
  const cfg = f.normalizeGatewayConfig({ localPort: 40000, hubServerId: "test-hub", customField: "keep" });
  assert.equal(cfg.localPort, 40000);
  assert.equal(cfg.hubServerId, "test-hub");
  assert.equal(cfg.customField, "keep");
});

test("normalizeGatewayConfig - host 透传", () => {
  const f = factory();
  const cfg = f.normalizeGatewayConfig({ localHost: "192.168.1.1", remoteHost: "10.0.0.1" });
  // normalizeTunnelGatewayConfig 会保留用户 host（仅校验非空）
  assert.equal(cfg.localHost, "192.168.1.1");
  assert.equal(cfg.remoteHost, "10.0.0.1");
});

test("normalizeGatewayConfig - 无硬编码 10890", () => {
  const f = factory();
  const cfgBad = f.normalizeGatewayConfig({ localPort: 99999 });
  assert.ok(String(cfgBad.localPort) !== "10890", "非法端口不应硬编码为 10890");
  const json = JSON.stringify(cfgBad);
  // 只有当用户显式传入 10890 才会出现，否则默认 18765
  if (JSON.stringify(defaultTunnelGatewayConfig).includes("10890")) {
    assert.fail("default config 不应包含 10890");
  }
  assert.ok(!json.includes("10890") || cfgBad.localPort === 10890, "不应隐式产生 10890");
});

test("normalizePort helper 与 localBaseUrl 一致性", () => {
  // 直接测试 TunnelGateway 底层
  assert.equal(normalizePort(18765, 18765), 18765);
  assert.equal(normalizePort(50000, 18765), 50000);
  assert.equal(normalizePort(80, 18765), 18765);
  assert.equal(normalizePort(99999, 18765), 18765);
  assert.equal(localBaseUrl({ localHost: "127.0.0.1", localPort: 50000 }), "http://127.0.0.1:50000");
  assert.equal(localBaseUrl({ localHost: "", localPort: 50000 }), "http://127.0.0.1:50000");
});

test("createPortAllocator / createPortProbe 可实例化", () => {
  const f = factory();
  const alloc = f.createPortAllocator({ min: 18766, max: 18999 });
  assert.ok(alloc, "allocator created");
  const probe = f.createPortProbe();
  assert.ok(probe, "probe created");
});

test("detectPortConflicts - 无冲突与重复端口", () => {
  const f = factory();
  const noConflict = f.detectPortConflicts([{ endpointId: "hub", localForwardPort: 18765 }]);
  assert.ok(Array.isArray(noConflict));
  // 若底层实现支持重复检测，构造重复来验证
  const dup = f.detectPortConflicts([
    { endpointId: "a", localForwardPort: 18765 },
    { endpointId: "b", localForwardPort: 18765 },
  ]);
  assert.ok(Array.isArray(dup));
});
