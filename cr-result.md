# 📦 仓库名称：cc-proxy

**分支对比**：`a7dff32` -> `HEAD`（feature/suggestion-mode-toggle，最近 1 次提交）

## 🏁 总结评述

* **整体评价**：9.4 分（严重×1，改进×7，重构×3）
* **核心风险**：`src/debug-log.js` 的写流未挂 `error` 监听，磁盘异常会直接击穿代理进程 —— 与文件头「日志失败绝不影响代理流量」的承诺相悖

## 📊 变更统计

| 指标 | 数值 |
|------|------|
| 涉及文件数 | 17 个（已由 env 脚本剔除自动生成文件） |
| 新增行数 | +1189 |
| 删除行数 | -44 |
| 净变更行数 | +1145 |
| 涉及提交数 | 1 个 |

**主要变更文件：**

| 文件路径 | 新增 | 删除 | 变更类型 |
|---------|------|------|----------|
| `bin/claude-proxy.js` | +21 | -2 | 修改 |
| `bin/settings-cli.js` | +20 | -9 | 修改 |
| `README.en.md` | +63 | -5 | 修改 |
| `README.md` | +55 | -5 | 修改 |
| `src/debug-log.js` | +73 | -0 | 新增 |
| `src/proxy.js` | +71 | -7 | 修改 |
| `src/settings.js` | +26 | -10 | 修改 |
| `src/suggestion-mode.js` | +82 | -0 | 新增 |
| `src/usage.js` | +119 | -0 | 新增 |
| `test/cli.test.mjs` | +19 | -0 | 新增 |
| `test/debug-log.test.mjs` | +59 | -0 | 新增 |
| `test/proxy-suggestion.test.mjs` | +169 | -0 | 新增 |
| `test/proxy-usage-debug.test.mjs` | +155 | -0 | 新增 |
| `test/settings-cli.test.mjs` | +22 | -3 | 修改 |
| `test/settings.test.mjs` | +26 | -3 | 修改 |
| `test/suggestion-mode.test.mjs` | +107 | -0 | 新增 |
| `test/usage.test.mjs` | +102 | -0 | 新增 |

**一句话摘要：** 本次改动 17 个文件，主要涉及 Suggestion Mode 请求识别与拦截、按日 token 用量统计、debug 日志落盘三条新链路，并配套补齐 6 个测试文件。

## 📝 变更概述

* **Suggestion Mode**：新增 `src/suggestion-mode.js`，从请求体文本提取 `[SUGGESTION MODE` 标记识别输入建议请求；`src/proxy.js` 依据 `forwardSuggestionMode` 配置决定放行或本地短路，`src/settings.js` 增加该开关的持久化字段。
* **用量统计**：新增 `src/usage.js`，从 SSE 的 `message_start` / `message_delta` 事件累计 input/output/cache token，按本地日期键落盘到 `~/.cc-proxy/usage.json`。
* **debug 日志**：新增 `src/debug-log.js`，`CC_PROXY_LOG=1` 时按请求落盘 headers / body / SSE 事件 / 状态码与耗时。
* **CLI**：`bin/claude-proxy.js` 新增 `--version` / `-v` 处理与退出时的会话用量摘要；`bin/settings-cli.js` 设置页新增 Suggestion Mode 菜单项。
* **文档**：两份 README 同步补充上述三项能力的说明。
* **测试**：新增 `usage` / `suggestion-mode` / `debug-log` / `proxy-suggestion` / `proxy-usage-debug` / `cli` 六组用例，扩展 `settings` 与 `settings-cli`。

## 🚨 深度审查意见

### 🚫 严重问题 (Critical) - 共 1 个

**1、**

* **问题描述**：`fs.createWriteStream` 的写流错误只通过异步 `'error'` 事件抛出，`try/catch` 仅能捕获同步异常（如 mkdir 失败），流对象上未挂任何 `error` 监听。此外 `writeLine` 在流已 `end()` 后再写入会触发 `ERR_STREAM_WRITE_AFTER_END`，同样以 `'error'` 事件形式抛出。两处均无监听器，Node 对无监听的 `'error'` 事件会直接抛出未捕获异常终止进程。
* **潜在影响**：磁盘满（ENOSPC）、权限变更（EACCES）、写入超时等任一情况都会让整个代理进程崩溃，直接中断正在进行的 Claude Code 会话，与文件头注释「任何写失败静默丢弃，绝不影响代理流量」的承诺完全相反；`requestEnd` 若被重复调用（如同时挂 `end` 与 `close`）也会二次写入已结束的流而崩溃。
* **位置**：`src/debug-log.js:L24-L33`（`openLogFile`）、`src/debug-log.js:L61-L65`（`requestEnd` 的 `stream.end()`）
* **修复对比**：

  ```js
  // ❌ 原始代码
  try {
      fs.mkdirSync(dir, { recursive: true });
      return fs.createWriteStream(path.join(dir, name), { flags: 'a' });
  } catch {
      return null;
  }
  // ... 以及
  requestEnd(stream, statusCode, startedAtMs) {
      if (!stream) return;
      writeLine(stream, `# status=${statusCode} duration=${ms}ms`);
      stream.end();
  }

  // ✅ 修复代码
  try {
      fs.mkdirSync(dir, { recursive: true });
      const stream = fs.createWriteStream(path.join(dir, name), { flags: 'a' });
      // 写流错误是异步事件，必须挂监听，否则会抛未捕获异常终止进程
      stream.on('error', () => {});
      return stream;
  } catch {
      return null;
  }
  // ... 以及
  requestEnd(stream, statusCode, startedAtMs) {
      if (!stream || stream.destroyed || stream.writableEnded) return;
      writeLine(stream, `# status=${statusCode} duration=${ms}ms`);
      stream.end();
  }
  ```

* **修复重点**：在 `createWriteStream` 后立即挂 `stream.on('error', () => {})` 兜底；`writeLine` 与 `requestEnd` 增加 `stream.destroyed || stream.writableEnded` 幂等守卫。

### ⚠️ 改进建议 (Standard) - 共 7 个

**2、** `record()` 每次请求都同步全量读 + 全量写文件，在代理热路径上阻塞事件循环（一次请求 = 一次 `readFileSync` + 一次 `writeFileSync`），并发请求下会成为吞吐瓶颈。

* **位置**：`src/usage.js:L95-L110`
* **修复对比**：

  ```js
  // ❌ 原始代码：每条请求都同步读改写整个文件
  const record = (usage) => {
      if (!usage) return;
      const key = dayKey(now());
      const all = readUsageFile(usageFile);
      const day = normalizeDay(all[key]);
      day.requests += 1;
      for (const field of NUM_FIELDS) day[field] += usage[field];
      all[key] = day;
      try {
          fs.mkdirSync(path.dirname(usageFile), { recursive: true });
          fs.writeFileSync(usageFile, JSON.stringify(all, null, 2) + '\n');
          dirty = true;
      } catch { /* 落盘失败不阻塞代理流量。 */ }
  };

  // ✅ 修复代码：内存累加 + 定时/退出前合并落盘（同一进程内读写不再逐请求触发）
  let cache = null;
  let flushTimer = null;
  const flush = () => {
      if (!cache) return;
      try {
          fs.mkdirSync(path.dirname(usageFile), { recursive: true });
          fs.writeFileSync(usageFile, JSON.stringify(cache, null, 2) + '\n');
          dirty = true;
      } catch { /* 落盘失败不阻塞代理流量。 */ }
  };
  const record = (usage) => {
      if (!usage) return;
      if (!cache) cache = readUsageFile(usageFile);
      const key = dayKey(now());
      const day = normalizeDay(cache[key]);
      day.requests += 1;
      for (const field of NUM_FIELDS) {
          const v = usage[field];
          if (Number.isInteger(v) && v > 0) day[field] += v;
      }
      cache[key] = day;
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 1000).unref();
  };
  ```

**3、** `record()` 只判 `!usage` 而不校验各计数字段，调用方传入缺字段的对象时 `day[field] += undefined` 会得到 `NaN`，`JSON.stringify` 把 `NaN` 序列化为 `null`，下次读取时被 `normalizeDay` 归零，导致历史累计值被静默抹掉（数据丢失而非报错）。

* **位置**：`src/usage.js:L98-L105`
* **修复对比**：

  ```js
  // ❌ 原始代码：字段缺失即污染为 NaN → 落盘 null → 累计值丢失
  day.requests += 1;
  for (const field of NUM_FIELDS) day[field] += usage[field];

  // ✅ 修复代码：逐字段做整数校验，非法值按 0 计
  day.requests += 1;
  for (const field of NUM_FIELDS) {
      const v = usage[field];
      if (Number.isInteger(v) && v > 0) day[field] += v;
  }
  ```

**4、** `extractUsageFromResponseEvents()` 未防御非数组入参，传入 `undefined` / 非可迭代对象时 `for...of` 直接抛 `TypeError`，与同目录 `isSuggestionModeRequest` 的「缺字段/类型不符一律不命中，绝不抛出」容错风格不一致。

* **位置**：`src/usage.js:L43-L62`
* **修复对比**：

  ```js
  // ❌ 原始代码：无入参类型守卫
  export function extractUsageFromResponseEvents(events) {
      let result = null;
      for (const event of events) { /* ... */ }
      return result;
  }

  // ✅ 修复代码：非数组直接返回 null
  export function extractUsageFromResponseEvents(events) {
      if (!Array.isArray(events)) return null;
      let result = null;
      for (const event of events) { /* ... */ }
      return result;
  }
  ```

**5、** `writeLine` 完全忽略 `stream.write()` 的返回值，无背压处理：高流量 SSE 场景下磁盘写入慢于事件产生速度时，写缓冲会在内存中无限累积，违背「debug 日志绝不能影响代理」的设计目标。

* **位置**：`src/debug-log.js:L36-L44`
* **修复对比**：

  ```js
  // ❌ 原始代码
  try {
      stream.write(line + '\n');
  } catch {
      // 写失败静默：debug 日志绝不能影响代理。
  }

  // ✅ 修复代码
  // write() 的返回值是背压信号，try/catch 捕不到异步错误；背压时直接丢弃该行
  if (stream.writableEnded || stream.destroyed) return;
  if (!stream.write(line + '\n')) return; // 缓冲已满：丢弃 debug 数据，保代理流量
  ```

  （`stream.on('error')` 兜底见第 1 条）

**6、** 请求体原文（最多 512KB）被整体落盘到 `~/.cc-proxy/logs/`，其中可能包含用户粘贴的代码、密钥、凭据等内容；文件无保留期、无大小上限、未显式收紧权限，长期运行会持续累积。

* **位置**：`src/debug-log.js:L54-L56`
* **修复对比**：

  ```js
  // ❌ 原始代码
  if (bodyBuffer?.length) {
      writeLine(stream, `# request body (${bodyBuffer.length} bytes)`);
      writeLine(stream, bodyBuffer.toString('utf8').slice(0, 512 * 1024));
  }

  // ✅ 修复代码
  if (bodyBuffer?.length) {
      // 落盘前脱敏已知凭据形态，并按保留期/大小上限清理旧文件
      const redacted = bodyBuffer.toString('utf8')
          .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***')
          .slice(0, 512 * 1024);
      writeLine(stream, `# request body (${bodyBuffer.length} bytes)`);
      writeLine(stream, redacted);
  }
  // createWriteStream 处补 mode: 0o600
  ```

**7、** 非 Claude Code 客户端分支新增的 `requestEnd` 仅挂在 `upstreamRes` 的 `'end'` 上；该分支没有 `error` 监听、也未监听 `res` 的 `close`，上游报错或客户端提前断开时日志写流既不会关闭（fd 泄漏），也不会记录结束行，与另两条分支的收尾处理不一致。

* **位置**：`src/proxy.js:L189-L192`
* **修复对比**：

  ```js
  // ❌ 原始代码
  res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
  upstreamRes.pipe(res);
  upstreamRes.on('end', () => dbg.requestEnd(logStream, upstreamRes.statusCode, requestStartedAt));

  // ✅ 修复代码
  res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
  upstreamRes.pipe(res);
  // 收尾需覆盖正常结束 / 上游错误 / 客户端断开三条路径（requestEnd 已加幂等守卫）
  const finishLog = () => dbg.requestEnd(logStream, upstreamRes.statusCode, requestStartedAt);
  upstreamRes.on('end', finishLog);
  upstreamRes.on('error', finishLog);
  res.on('close', finishLog);
  ```

**8、** `-v` 被 `--version` 一并劫持，破坏了「参数原样透传给 claude」的既有契约：用户执行 `cc-proxy -v`（期望传给 claude）会直接打印代理版本退出，且此前 `cc-proxy --version` 展示 Claude Code 版本的行为被静默改变。

* **位置**：`bin/claude-proxy.js:L30`
* **修复对比**：

  ```js
  // ❌ 原始代码
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
      const { version } = require('../package.json');
      process.stdout.write(`claude-proxy ${version}\n`);
      return;
  }

  // ✅ 修复代码
  // 只拦截明确的代理自有标志，避免劫持 claude 的短选项透传
  if (process.argv.includes('--proxy-version')) {
      const { version } = require('../package.json');
      process.stdout.write(`claude-proxy ${version}\n`);
      return;
  }
  ```

### 💡 优雅重构 (Refactoring) - 共 3 个

**9、** `src/proxy.js:L227-L231` — 事件收集条件应只看 `usage`，当前 `usage || logStream` 会在仅开启 debug 日志时把全部 `message_start` / `message_delta` 无谓留存在内存中（`dbg.recordEvent` 对 `null` 流本就无副作用）。

  ```js
  // ❌ 原始代码
  if (usage || logStream) {
      if (event.type === 'message_start' || event.type === 'message_delta') collected.push(event);
      dbg.recordEvent(logStream, event);
  }

  // ✅ 修复代码
  if (usage && (event.type === 'message_start' || event.type === 'message_delta')) collected.push(event);
  dbg.recordEvent(logStream, event); // 关闭态为空实现，无需外层判空
  ```

**10、** `bin/settings-cli.js:L102` — 局部常量 `write`（输出流写函数）与 `deps.write`（配置落盘函数）同名，同一函数体内两种 `write` 语义并存，易误读为同一职责。

  ```js
  // ❌ 原始代码
  const write = (s) => deps.output.write(s);
  // ...
  config = deps.write({ forwardSuggestionMode: !config.forwardSuggestionMode });

  // ✅ 修复代码：重命名输出函数，与落盘函数区分
  const print = (s) => deps.output.write(s);
  // ...
  config = deps.write({ forwardSuggestionMode: !config.forwardSuggestionMode });
  ```

**11、** `test/proxy-suggestion.test.mjs:L121-L147` — upstream 的关闭写在循环与断言之后而非 `finally`，一旦循环内任一断言失败，`upstream.close()` 被跳过，listening Server 句柄残留导致测试进程挂起（注释已自述该风险，但位置未落实）。

  ```js
  // ❌ 原始代码：异常路径下 upstream 不会关闭
  for (const forwardSuggestionMode of [false, true]) {
      const proxy = createProxyServer({ /* ... */ });
      await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
      try {
          // ...
          assert.equal(res.status, 200);
      } finally {
          proxy.closeAllConnections?.();
          proxy.close();
      }
  }
  assert.equal(state.bodies.length, 2);
  upstream.closeAllConnections?.();
  upstream.close();

  // ✅ 修复代码：把 upstream 一并纳入外层 try/finally
  try {
      for (const forwardSuggestionMode of [false, true]) {
          const proxy = createProxyServer({ /* ... */ });
          await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
          try { /* ... */ } finally {
              proxy.closeAllConnections?.();
              proxy.close();
          }
      }
      assert.equal(state.bodies.length, 2);
  } finally {
      upstream.closeAllConnections?.();
      upstream.close();
  }
  ```
