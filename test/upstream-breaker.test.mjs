import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamBreaker } from '../src/upstream-breaker.js';

// 可控时钟：测试用 fake now，避免真实等待。
function makeClock(start = 0) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

test('closed 状态默认放行且非探测', () => {
    const { probe, getState } = createUpstreamBreaker();
    assert.deepEqual(probe('a'), { allowed: true, isProbe: false });
    assert.equal(getState('a'), 'closed');
});

test('连续失败达到 3 次触发熔断（成功清零）', () => {
    const clock = makeClock();
    const b = createUpstreamBreaker({ now: clock.now });
    b.recordFailure('a');
    b.recordFailure('a');
    b.recordSuccess('a'); // 成功清零
    b.recordFailure('a');
    b.recordFailure('a');
    assert.equal(b.getState('a'), 'closed');
    b.recordFailure('a'); // 第 3 次连续失败
    assert.equal(b.getState('a'), 'open');
    // open 且冷却未过：不放行
    assert.deepEqual(b.probe('a'), { allowed: false, isProbe: false });
});

test('未达阈值不熔断', () => {
    const clock = makeClock();
    const b = createUpstreamBreaker({ now: clock.now });
    b.recordFailure('a');
    b.recordFailure('a');
    assert.equal(b.isOpen('a'), false);
});

test('冷却期满后进入 half-open 并放行 1 个探测', () => {
    const clock = makeClock();
    const b = createUpstreamBreaker({ now: clock.now, cooldownMs: 30000 });
    b.recordFailure('a');
    b.recordFailure('a');
    b.recordFailure('a');
    assert.equal(b.getState('a'), 'open');
    clock.advance(29999);
    assert.deepEqual(b.probe('a'), { allowed: false, isProbe: false });
    clock.advance(1);
    assert.deepEqual(b.probe('a'), { allowed: true, isProbe: true });
    assert.equal(b.getState('a'), 'half-open');
});

test('half-open 并发第二个请求被拒绝（走备用）', () => {
    const clock = makeClock();
    const b = createUpstreamBreaker({ now: clock.now });
    b.recordFailure('a');
    b.recordFailure('a');
    b.recordFailure('a');
    clock.advance(30000);
    assert.deepEqual(b.probe('a'), { allowed: true, isProbe: true });
    assert.deepEqual(b.probe('a'), { allowed: false, isProbe: false });
    // 非熔断上游不受影响
    assert.deepEqual(b.probe('b'), { allowed: true, isProbe: false });
});

test('探测占用泄漏时超时惰性释放，不永久卡 half-open', () => {
    const clock = makeClock();
    const b = createUpstreamBreaker({ now: clock.now, cooldownMs: 30000 });
    b.recordFailure('a');
    b.recordFailure('a');
    b.recordFailure('a');
    clock.advance(30000);
    b.probe('a'); // 探测放行后调用方永不回报（泄漏）
    clock.advance(30000);
    assert.deepEqual(b.probe('a'), { allowed: true, isProbe: true }); // 占用已失效，重新放行
    // 惰性释放后的探测仍正常驱动状态迁移
    b.recordSuccess('a');
    assert.equal(b.getState('a'), 'closed');
});

test('探测成功恢复 closed，后续请求恢复主优先', () => {
    const clock = makeClock();
    const b = createUpstreamBreaker({ now: clock.now });
    b.recordFailure('a');
    b.recordFailure('a');
    b.recordFailure('a');
    clock.advance(30000);
    b.probe('a');
    b.recordSuccess('a');
    assert.equal(b.getState('a'), 'closed');
    assert.deepEqual(b.probe('a'), { allowed: true, isProbe: false });
});

test('探测失败重新熔断并重新计时', () => {
    const clock = makeClock();
    const b = createUpstreamBreaker({ now: clock.now, cooldownMs: 30000 });
    b.recordFailure('a');
    b.recordFailure('a');
    b.recordFailure('a');
    clock.advance(30000);
    b.probe('a');
    b.recordFailure('a'); // 探测失败 → open 重新计时
    assert.equal(b.getState('a'), 'open');
    // 新冷却期内不放行
    clock.advance(1000);
    assert.deepEqual(b.probe('a'), { allowed: false, isProbe: false });
    clock.advance(29000);
    assert.deepEqual(b.probe('a'), { allowed: true, isProbe: true });
});

test('getSnapshot 提供 state/consecutiveFailures/cooldownRemainingMs', () => {
    const clock = makeClock();
    const b = createUpstreamBreaker({ now: clock.now, cooldownMs: 30000 });
    b.recordFailure('a');
    b.recordFailure('a');
    b.recordFailure('a');
    clock.advance(1000);
    const snap = b.getSnapshot();
    assert.equal(snap.a.state, 'open');
    assert.equal(snap.a.consecutiveFailures, 3);
    assert.equal(snap.a.cooldownRemainingMs, 29000);
    // 冷却已过（惰性迁移 half-open）后剩余为 0
    clock.advance(30000);
    const snap2 = b.getSnapshot();
    assert.equal(snap2.a.state, 'half-open');
    assert.equal(snap2.a.cooldownRemainingMs, 0);
});

test('未知上游按 closed 处理；非法 id 忽略', () => {
    const { getState, isOpen, probe, recordFailure } = createUpstreamBreaker();
    assert.equal(getState('nope'), 'closed');
    assert.equal(isOpen('nope'), false);
    recordFailure('');
    recordFailure(null);
    assert.deepEqual(probe(''), { allowed: false, isProbe: false });
});

test('closed 上游失败计数到达阈值时才熔断，half-open 不受 closed 阈值影响', () => {
    const clock = makeClock();
    const b = createUpstreamBreaker({ now: clock.now, failureThreshold: 3 });
    b.recordFailure('a');
    b.recordFailure('a');
    clock.advance(30000); // 未 open，惰性迁移不影响 closed
    assert.equal(b.getState('a'), 'closed');
    b.recordFailure('a'); // 第 3 次
    assert.equal(b.getState('a'), 'open');
});
