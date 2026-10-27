// 复盘串行队列 + 总时限（第 39 轮）。
//
// 要解决的问题（根因见 FIX-REPORT-R39 / DESIGN.md 第 39 轮）：
// 自动复盘原先跑在宿主的维护相位里（agent.runMaintenance），宿主 :822-845 的 runMaintenance
// 在 job 返回前一直保持 phase.kind === 'maintenance'，而 wakeDriver（:854-857）在非 idle 相位
// 只置 wakeRequested 就 return —— 只要复盘不结束，之后到达的用户消息永远排队，
// UI 表现就是「发出去了完全没反应」。provider 静默（dsh-llm-pi-ai 的 300000ms idle 看门狗
// + dsh-llm-retry 的指数退避，实测单次可挂数分钟）× 最多 8 次串行调用 ⇒ 小时级挂死。
//
// 这一层做三件事：
// 1) 复盘不再占宿主维护相位：队列只是插件自己的等待，runRecap 调用方自己起的那段
//    「排队 + 执行」跑在 recap.js 已经 await 住的 promise 里，宿主的相位始终是 idle，
//    用户消息照常被 send/followup 处理（详见 fix-report.md 的「可行性评估」一节）。
// 2) 全局串行：任一时刻只有一份复盘在跑，避免两路复盘同时「读手册 → 检查候选 → 写入手册」
//    （withExclusiveLock 只保护单次写入那一段，保护不了检查到写入之间）。
// 3) 总时限：一份复盘从开始到放弃最多 RECAP_TOTAL_DEADLINE_MS，超时后**开始叫停并等它真的停下**：
//    到点即 abort 本份复盘自己的 AbortController（signal 一路传到 runRecapPipeline / oneShot），
//    并且**在真正放行下一份之前先 await 上游 promise 结束**（无论它是正常返回、抛错还是被 abort）。
//    这样「总时限之后串行性不成立」这个缺陷才真的修掉：改动前到点只把 state.running 置回 false，
//    被放弃的那份还在写手册，下一份立刻开始，同一时刻两份复盘同时跑（exp/overlap2.mjs
//    实测 maxOverlap 2、用户 150ms 时被告知「没有并入手册」而 250ms 后同两条已写进手册）。
//    本模块只 abort **自己建的这个 controller**，绝不碰宿主的 maintenance signal —— 自动复盘
//    本就不占宿主维护相位，没有宿主 signal 可 abort。
//
// 本模块零 import（不依赖宿主包、不依赖本仓库其它 lib），可独立测试。

// 一份复盘从开始跑到放弃的总时限。取 120000ms：
// - 用户可接受的一次「回合结束后的后台沉淀」等待，超过就该让用户知道失败而不是继续按住；
// - 与单次调用上限 ONESHOT_TIMEOUT_MS=75000 的关系：2 次单次调用就够触顶，
//   8 次串行调用不可能全部跑完，最坏总耗时被压在这一量级（详见 fix-report.md 的最坏估算）；
// - 区间 90000–180000 的中值偏保守一侧：宁可早 30 秒放弃让用户重试，也不让队列再叠 60 秒。
// 测试可以用 ACE_RECAP_TOTAL_DEADLINE_MS 把它压到几十毫秒（e2e.test.mjs 已有
// ACE_E2E_DEBUG 这种环境变量先例；红线只禁「新增 npm 依赖」，不禁读环境变量）。
// 生产环境不设置这个变量，走上面的默认值。
export const RECAP_TOTAL_DEADLINE_MS = readDeadlineOverride('ACE_RECAP_TOTAL_DEADLINE_MS', 120000);

function readDeadlineOverride(name, fallback) {
  try {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

// 队列里最多允许的待跑项数（不含正在跑的那一份）。超出就丢弃最旧的一项并 warn：
// 复盘是对「已经结束的回合」的离线沉淀，越旧的回合价值越低，而排队越长则用户看到
// 「手册一直没更新」的观感越差；2 是「留一项缓冲 + 不无限堆积」的折中。
export const MAX_QUEUED_RECAPS = 2;

export function createRecapQueue({ logger, totalDeadlineMs = RECAP_TOTAL_DEADLINE_MS, maxQueued = MAX_QUEUED_RECAPS } = {}) {
  const state = {
    running: false,
    // 待跑项：{ agentId, label, run, onGiveUp, onFailed }
    // - run(signal) 返回 Promise（由调用方提供「执行一份复盘」的整段逻辑）。
    //   第 39 轮缺陷 1 修复：队列会为每一份建一个 AbortController，总时限到点就 abort，
    //   并把 signal 作为第一个参数传给 run —— 调用方负责把它一路透传到
    //   runRecapPipeline → oneShot（lib/llm.js 的 mergeSignals 会合并调用方 signal）。
    //   run 不声明形参也照常工作（JS 不校验实参个数），老形状调用方零改动。
    // - onGiveUp(reason) 可选：这一份因总时限放弃或真失败时通知调用方（复用 notifyFailure 文案）
    // - onFailed(reason) 可选：**只有真失败**（不是总时限放弃）时通知调用方，
    //   缺陷 2 的回滚钩子 —— 复盘在队列里失败会绕过 lib/recap.js 的 catch（那条 catch
    //   只在 runRecap 同步抛错时触发），mutating 计数得由调用方在这里补还。
    queue: [],
    // 观测：累计跑了几份、因合并被吃掉几份、因超上限被丢弃几份、因总时限放弃几份
    started: 0,
    merged: 0,
    dropped: 0,
    abandoned: 0,
    maxConcurrent: 0,
    concurrent: 0,
  };

  function log(message) {
    try {
      if (logger && typeof logger.info === 'function') logger.info(message);
      else if (logger && typeof logger.warn === 'function') logger.warn(message);
    } catch {}
  }

  // 入队：FIFO；已有待跑项则把新回合并进最后一项（合并而不是排长队）。
  // merge 由调用方提供（把新 summary 并进旧项），不提供则退化成「替换 label」。
  // 第 40 轮缺陷 6：合并分支以前在**生产里根本走不到** —— lib/index.js 的 enqueue 调用
  // 从来只传一个参数，于是「已有待跑项」时永远是「排长队 → 涨到上限 → 丢最旧」。
  // 现在调用方必须传 merge（见 lib/index.js 的 mergeRecapItems），合并才真的可达。
  function enqueue(item, merge) {
    const last = state.queue[state.queue.length - 1];
    if (last && typeof merge === 'function') {
      const combined = merge(last, item);
      if (combined) {
        state.merged += 1;
        log('dsh-ace: 复盘排队——新回合的复盘并进已在排队的那一份（累计合并 ' + state.merged + ' 次），队列长度保持 ' + state.queue.length);
        return { queued: false, merged: true, item: last };
      }
    }
    if (state.queue.length >= maxQueued) {
      const dropped = state.queue.shift();
      state.dropped += 1;
      const dropReason = '复盘排队已满（' + maxQueued + ' 项），丢弃最旧的一份复盘（'
        + (dropped && dropped.label) + '），这份经验未并入手册';
      log('dsh-ace: ' + dropReason);
      // 第 40 轮缺陷 6：丢经验以前是**完全静默**的 —— 只在日志里留一句，用户永远不知道
      // 自己那一轮的沉淀被扔了。现在走 onDrop 让调用方发一次性 notice（form==='notice' 通道），
      // 文案必须说真话：「这次真的丢了，下回合还能再攒再试」，不许含糊成「稍后处理」。
      drop(dropped, dropReason);
      // 被丢弃的那一份永远不会有 run 结果：这里就地 settle，让 await 它的调用方
      // （/ace 命令）不会悬着 —— 丢掉的经验确实没并入手册，结论就是 ok:false。
      settle(dropped, { ok: false, dropped: true, reason: dropReason });
    }
    state.queue.push(item);
    return { queued: true, merged: false, item };
  }

  // 「这一份没跑成」时通知调用方（onGiveUp）：绝不抛错，通知失败只当没通知。
  function giveUp(item, reason) {
    try {
      if (item && typeof item.onGiveUp === 'function') item.onGiveUp(reason);
    } catch {}
  }

  // 「这一份被队列丢掉」时通知调用方（onDrop，第 40 轮缺陷 6）。
  // 与 giveUp 的区别：giveUp 是「跑过了但没跑成」，onDrop 是「压根没跑，经验被扔了」——
  // 这两件事对用户的含义完全不同，文案不许共用。
  function drop(item, reason) {
    try {
      if (item && typeof item.onDrop === 'function') item.onDrop(reason);
    } catch {}
  }

  // 「这一份的最终结局」通知调用方（onSettled，第 40 轮缺陷 5 新增）。
  // 与上面三个钩子的区别：那三个是**通知用户**的（要不要打扰用户由调用方决定），
  // 这一个只回答「这一份到底成没成」，给需要拿到结果的调用方用（/ace 命令要回一句
  // 「复盘完成，新增 N 条」）。**每一次入队的项都恰好 settle 一次**：
  // 成功、超时放弃、真失败、被队列丢弃、以及被合并吃掉（由合并件带着两方的回调一起 settle）。
  function settle(item, outcome) {
    try {
      if (item && typeof item.onSettled === 'function') item.onSettled(outcome);
    } catch {}
  }

  // 「这一份真失败了」时通知调用方（onFailed，第 39 轮缺陷 2 的回滚钩子）。
  // 与 giveUp 的区别：**只有真失败才调**（总时限放弃不调）——放弃的那份可能已经写了
  // 一部分手册，回滚 mutating 计数反而会让下一轮把同一批经验再复盘一次。
  function fail(item, reason) {
    try {
      if (item && typeof item.onFailed === 'function') item.onFailed(reason);
    } catch {}
  }

  function drain() {
    if (state.running) return;
    const next = state.queue.shift();
    if (!next) return;
    state.running = true;
    state.started += 1;
    state.concurrent += 1;
    if (state.concurrent > state.maxConcurrent) state.maxConcurrent = state.concurrent;
    const startedAt = Date.now();
    log('dsh-ace: 复盘开始（agent ' + next.agentId + '，队列还剩 ' + state.queue.length + ' 项）');
    // 第 39 轮缺陷 1 修复：本份复盘自己的 AbortController。总时限到点 abort 它，
    // 并把 signal 传给 run（→ runRecapPipeline → oneShot 的 mergeSignals 合并）。
    // 只 abort 自己的 controller：宿主的 maintenance signal 在本路径上不存在（复盘不占相位）。
    const controller = new AbortController();
    // 总时限的含义从「我们不等了」变成「我们开始叫停，并等它真的停下」：
    // 到点 abort + resolve('timeout')，但下面**先 await 上游真正 settle** 才置 running=false。
    const deadline = new Promise((resolve) => {
      const timer = setTimeout(() => {
        controller.abort('ace: 复盘超过总时限 ' + totalDeadlineMs + 'ms');
        resolve('timeout');
      }, totalDeadlineMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    // 上游单独存一份：timeout 分支要 await 它真正结束（正常返回 / 抛错 / 被 abort 都算）。
    // 第 45 轮：第二参把「这份复盘的绝对截止时刻」交给 run —— 复盘管线用它给每次 LLM 调用
    // 派剩余预算（lib/recap-pipeline.js 的 makeRecapBudget），让提炼/合并/落盘在总时限里
    // 各自有份额，而不是全挤到总时限处被整份放弃。run 不声明形参也照常工作（向后兼容）。
    const upstream = Promise.resolve().then(() => next.run(controller.signal, { deadlineAt: startedAt + totalDeadlineMs }));
    (async () => {
      let result;
      try {
        result = await Promise.race([upstream, deadline]);
      } catch (error) {
        result = { error };
      }
      if (result === 'timeout') {
        // 关键：**放行之前先等上游真的停下**。provider 真的消费 signal 时它很快就会 reject
        // （lib/llm.js 的 for-await 会把 abort 抛出来）；provider 忽略 signal 时最坏退化成
        // 「连等待也一起等」—— 但这段等待发生在插件自己的 promise 里，不占宿主任何相位，
        // 用户消息照常通行。绝不能不等到点就置 running=false：那正是缺陷 1（两份复盘
        // 同时检查/写手册）的成因。
        try {
          await upstream;
        } catch {
          // 上游因 abort / 自身错误而结束：这正是我们要等的「停下」，不当失败处理。
        }
      }
      state.concurrent -= 1;
      state.running = false;
      const elapsed = Date.now() - startedAt;
      if (result === 'timeout') {
        state.abandoned += 1;
        const reason = '复盘超过总时限 ' + totalDeadlineMs + 'ms';
        log('dsh-ace: 复盘超过总时限 ' + totalDeadlineMs + 'ms（agent ' + next.agentId + '），已中断并等上游停止（第 '
          + state.abandoned + ' 次），已写入的部分会保留，未完成的经验可在下回合重试');
        // 放弃必须让用户知道：走调用方给的 onGiveUp（与 lib/recap.js 的 notifyFailure 同一套文案）。
        // 刻意**不调** onFailed：放弃不是失败，mutating 计数不该回滚（那份待办可能已经写了部分手册）。
        giveUp(next, reason);
        settle(next, { ok: false, timeout: true, reason });
      } else if (result && result.error) {
        const message = String((result.error && result.error.message) || result.error);
        log('dsh-ace: 复盘失败（agent ' + next.agentId + '，耗时 ' + elapsed + 'ms）：' + message);
        giveUp(next, '复盘失败（' + message + '）');
        // 缺陷 2：队列里的真失败绕过 lib/recap.js 的 catch，mutating 计数的回滚在这里补。
        fail(next, '复盘失败（' + message + '）');
        settle(next, { ok: false, reason: '复盘失败（' + message + '）', error: result.error });
      } else {
        log('dsh-ace: 复盘结束（agent ' + next.agentId + '，耗时 ' + elapsed + 'ms，队列还剩 ' + state.queue.length + ' 项）');
        // 成功：把 run 的返回值（executeRecap 的结果：added / conflicts / entries …）
        // 原样交给调用方 —— /ace 的「复盘完成，新增 N 条」就靠它。
        settle(next, { ok: true, result });
      }
      drain();
    })();
  }

  return {
    state,
    enqueue,
    drain,
    get size() { return state.queue.length; },
    get busy() { return state.running; },
    // 供测试/观测读取的快照（纯数据，不暴露内部数组）
    snapshot() {
      return {
        queued: state.queue.length,
        running: state.running,
        started: state.started,
        merged: state.merged,
        dropped: state.dropped,
        abandoned: state.abandoned,
        maxConcurrent: state.maxConcurrent,
      };
    },
  };
}
