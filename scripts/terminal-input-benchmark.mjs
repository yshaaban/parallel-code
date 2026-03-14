const DEFAULT_MAX_PENDING_CHARS = 2 * 1024;
const PASTE_MAX_PENDING_CHARS = 32 * 1024;
const MAX_SEND_BATCH_CHARS = 4_000;
const PROTOCOL_MAX_CHARS = 4_096;
const IMMEDIATE_FLUSH_INPUTS = ['\r', '\u0003', '\u0004', '\u001a'];

function isLikelyPaste(data) {
  return data.length >= 256 || (data.includes('\n') && data.length >= 64);
}

function hasImmediateFlushInput(data) {
  return IMMEDIATE_FLUSH_INPUTS.some((value) => data.includes(value));
}

function getAdaptivePlan(data) {
  if (hasImmediateFlushInput(data)) {
    return {
      flushImmediately: true,
      flushDelayMs: 0,
      maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
    };
  }

  if (isLikelyPaste(data)) {
    return {
      flushImmediately: false,
      flushDelayMs: 2,
      maxPendingChars: PASTE_MAX_PENDING_CHARS,
    };
  }

  if (data.length <= 1) {
    return {
      flushImmediately: false,
      flushDelayMs: 4,
      maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
    };
  }

  return {
    flushImmediately: false,
    flushDelayMs: 8,
    maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
  };
}

function createHybridStrategy(name, singleCharFlushDelayMs) {
  return {
    name,
    getPlan(data) {
      if (hasImmediateFlushInput(data)) {
        return {
          flushImmediately: true,
          flushDelayMs: 0,
          maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
        };
      }

      if (isLikelyPaste(data)) {
        return {
          flushImmediately: false,
          flushDelayMs: 2,
          maxPendingChars: PASTE_MAX_PENDING_CHARS,
        };
      }

      return {
        flushImmediately: false,
        flushDelayMs: data.length <= 1 ? singleCharFlushDelayMs : 8,
        maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
      };
    },
    chunkBeforeQueue: true,
    coalesceQueue: true,
    rescheduleFlush: false,
  };
}

const strategies = {
  current: {
    name: 'current',
    getPlan(data) {
      return {
        flushImmediately: false,
        flushDelayMs: data.length <= 1 ? 0 : 8,
        maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
      };
    },
    chunkBeforeQueue: false,
    coalesceQueue: false,
    rescheduleFlush: false,
  },
  currentSafeChunked: {
    name: 'current+safe-chunked',
    getPlan(data) {
      return {
        flushImmediately: false,
        flushDelayMs: data.length <= 1 ? 0 : 8,
        maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
      };
    },
    chunkBeforeQueue: true,
    coalesceQueue: false,
    rescheduleFlush: false,
  },
  currentSafeChunkedCoalesced: {
    name: 'current+safe+coalesced',
    getPlan(data) {
      return {
        flushImmediately: false,
        flushDelayMs: data.length <= 1 ? 0 : 8,
        maxPendingChars: DEFAULT_MAX_PENDING_CHARS,
      };
    },
    chunkBeforeQueue: true,
    coalesceQueue: true,
    rescheduleFlush: false,
  },
  hybridSafeCoalesced: createHybridStrategy('hybrid+safe+coalesced', 0),
  hybrid4msSafeCoalesced: createHybridStrategy('hybrid-4ms+safe+coalesced', 4),
  hybrid8msSafeCoalesced: createHybridStrategy('hybrid-8ms+safe+coalesced', 8),
  adaptiveSafe: {
    name: 'adaptive+safe',
    getPlan: getAdaptivePlan,
    chunkBeforeQueue: true,
    coalesceQueue: false,
    rescheduleFlush: true,
  },
  adaptiveSafeCoalesced: {
    name: 'adaptive+safe+coalesced',
    getPlan: getAdaptivePlan,
    chunkBeforeQueue: true,
    coalesceQueue: true,
    rescheduleFlush: true,
  },
};

function createScenarioEvents() {
  return [
    {
      name: 'typing',
      events: Array.from({ length: 120 }, (_, index) => ({
        timeMs: index * 40,
        data: 'a',
      })),
    },
    {
      name: 'held-key-burst',
      events: Array.from({ length: 300 }, (_, index) => ({
        timeMs: index * 4,
        data: 'a',
      })),
    },
    {
      name: 'large-paste',
      events: [
        {
          timeMs: 0,
          data: `npm run dev\n${'x'.repeat(16 * 1024)}`,
        },
      ],
    },
    {
      name: 'chunked-paste',
      events: Array.from({ length: 16 }, (_, index) => ({
        timeMs: index,
        data: `${'y'.repeat(1024)}\n`,
      })),
    },
  ];
}

function splitQueuedItems(parts, maxChars) {
  const items = [];
  let currentParts = [];
  let currentLength = 0;

  for (const part of parts) {
    let remainingLength = part.length;
    while (remainingLength > 0) {
      const space = maxChars - currentLength;
      const take = Math.min(space, remainingLength);
      currentParts.push({ eventId: part.eventId, length: take });
      currentLength += take;
      remainingLength -= take;

      if (currentLength >= maxChars) {
        items.push({ parts: currentParts, length: currentLength });
        currentParts = [];
        currentLength = 0;
      }
    }
  }

  if (currentLength > 0) {
    items.push({ parts: currentParts, length: currentLength });
  }

  return items;
}

function coalesceQueuedItems(queue) {
  if (queue.length === 0) {
    return null;
  }

  const parts = [];
  let count = 0;
  let length = 0;

  while (count < queue.length) {
    const next = queue[count];
    if (length + next.length > MAX_SEND_BATCH_CHARS) {
      break;
    }

    parts.push(...next.parts);
    length += next.length;
    count += 1;
  }

  if (length === 0) {
    return null;
  }

  return { count, item: { parts, length } };
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
    return sorted[index];
  };

  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    avg: sorted.length === 0 ? 0 : sum / sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
  };
}

function runScenario(strategy, scenario, sendLatencyMs) {
  const events = scenario.events.map((event, index) => ({
    ...event,
    id: index,
    length: event.data.length,
  }));
  const remainingByEvent = new Map(events.map((event) => [event.id, event.length]));
  const completionByEvent = new Map();
  const droppedByEvent = new Set();

  let nextEventIndex = 0;
  let currentTime = 0;
  let flushAt = null;
  let sendAt = null;
  let sendCount = 0;
  let droppedBatches = 0;
  let maxQueuedChars = 0;
  let pendingLength = 0;
  let pendingLimit = DEFAULT_MAX_PENDING_CHARS;
  let pendingParts = [];
  const queue = [];
  let activeSend = null;

  function updateMaxQueuedChars() {
    const queuedChars = queue.reduce((total, item) => total + item.length, pendingLength);
    maxQueuedChars = Math.max(maxQueuedChars, queuedChars);
  }

  function maybeStartSend() {
    if (sendAt !== null || queue.length === 0) {
      return;
    }

    const next =
      strategy.coalesceQueue
        ? coalesceQueuedItems(queue)
        : { count: 1, item: queue[0] };
    if (!next || !next.item) {
      return;
    }

    activeSend = next;
    sendAt = currentTime + sendLatencyMs;
    sendCount += 1;
  }

  function finishSend() {
    if (!activeSend) {
      return;
    }

    const { count, item } = activeSend;
    sendAt = null;
    activeSend = null;

    if (item.length > PROTOCOL_MAX_CHARS) {
      droppedBatches += 1;
      for (const part of item.parts) {
        droppedByEvent.add(part.eventId);
      }
      queue.splice(0, count);
      maybeStartSend();
      return;
    }

    queue.splice(0, count);
    for (const part of item.parts) {
      const remaining = remainingByEvent.get(part.eventId);
      if (remaining === undefined) {
        continue;
      }
      const nextRemaining = remaining - part.length;
      if (nextRemaining <= 0) {
        remainingByEvent.delete(part.eventId);
        completionByEvent.set(part.eventId, currentTime);
      } else {
        remainingByEvent.set(part.eventId, nextRemaining);
      }
    }

    maybeStartSend();
  }

  function flushPending() {
    flushAt = null;
    if (pendingLength === 0) {
      return;
    }

    const items = strategy.chunkBeforeQueue
      ? splitQueuedItems(pendingParts, MAX_SEND_BATCH_CHARS)
      : [{ parts: pendingParts, length: pendingLength }];
    queue.push(...items);
    pendingParts = [];
    pendingLength = 0;
    pendingLimit = DEFAULT_MAX_PENDING_CHARS;
    updateMaxQueuedChars();
    maybeStartSend();
  }

  function enqueueEvent(event) {
    const plan = strategy.getPlan(event.data);
    pendingParts.push({ eventId: event.id, length: event.length });
    pendingLength += event.length;
    pendingLimit = Math.max(pendingLimit, plan.maxPendingChars);

    if (plan.flushImmediately || pendingLength >= pendingLimit) {
      flushPending();
      return;
    }

    if (flushAt === null || strategy.rescheduleFlush) {
      flushAt = currentTime + plan.flushDelayMs;
    }

    updateMaxQueuedChars();
  }

  while (
    nextEventIndex < events.length ||
    flushAt !== null ||
    sendAt !== null ||
    pendingLength > 0 ||
    queue.length > 0
  ) {
    const nextEventAt = events[nextEventIndex]?.timeMs ?? Number.POSITIVE_INFINITY;
    const nextFlushAt = flushAt ?? Number.POSITIVE_INFINITY;
    const nextSendAt = sendAt ?? Number.POSITIVE_INFINITY;
    currentTime = Math.min(nextEventAt, nextFlushAt, nextSendAt);

    if (currentTime === nextEventAt) {
      enqueueEvent(events[nextEventIndex]);
      nextEventIndex += 1;
      continue;
    }

    if (currentTime === nextFlushAt) {
      flushPending();
      continue;
    }

    if (currentTime === nextSendAt) {
      finishSend();
    }
  }

  for (const event of events) {
    if (!completionByEvent.has(event.id) && !droppedByEvent.has(event.id)) {
      droppedByEvent.add(event.id);
    }
  }

  const latencies = events
    .filter((event) => completionByEvent.has(event.id))
    .map((event) => (completionByEvent.get(event.id) ?? currentTime) - event.timeMs);

  return {
    droppedEvents: droppedByEvent.size,
    droppedBatches,
    sendCount,
    maxQueuedChars,
    totalDurationMs: currentTime,
    latency: summarize(latencies),
  };
}

function printResult(strategyName, scenarioName, sendLatencyMs, result) {
  const status = result.droppedEvents > 0 ? 'DROP' : 'OK';
  console.log(
    [
      strategyName.padEnd(24),
      scenarioName.padEnd(18),
      `${sendLatencyMs}ms`.padEnd(6),
      status.padEnd(5),
      `writes=${String(result.sendCount).padStart(3)}`,
      `done=${String(Math.round(result.totalDurationMs)).padStart(5)}ms`,
      `p95=${String(Math.round(result.latency.p95)).padStart(4)}ms`,
      `maxQ=${String(result.maxQueuedChars).padStart(5)}`,
      `drops=${result.droppedEvents}`,
    ].join('  '),
  );
}

const scenarios = createScenarioEvents();
const latencies = [1, 5, 15];

console.log('Terminal input batching benchmark');
console.log(`Protocol-safe batch cap: ${MAX_SEND_BATCH_CHARS} chars`);
console.log('');

for (const strategy of Object.values(strategies)) {
  for (const scenario of scenarios) {
    for (const sendLatencyMs of latencies) {
      const result = runScenario(strategy, scenario, sendLatencyMs);
      printResult(strategy.name, scenario.name, sendLatencyMs, result);
    }
  }
  console.log('');
}

const PTY_BACKEND_BATCH_MAX_CHARS = 16 * 1024;

const backendStrategies = [
  {
    name: 'direct',
    flushDelayMs: null,
    maxBatchChars: PROTOCOL_MAX_CHARS,
  },
  {
    name: 'queue-0ms-16k',
    flushDelayMs: 0,
    maxBatchChars: PTY_BACKEND_BATCH_MAX_CHARS,
  },
  {
    name: 'queue-1ms-16k',
    flushDelayMs: 1,
    maxBatchChars: PTY_BACKEND_BATCH_MAX_CHARS,
  },
  {
    name: 'queue-2ms-32k',
    flushDelayMs: 2,
    maxBatchChars: 32 * 1024,
  },
];

function splitRendererQueuedMessages(parts, maxChars) {
  const items = [];
  let currentParts = [];
  let currentLength = 0;
  let currentData = '';

  for (const part of parts) {
    let remainingData = part.data;
    while (remainingData.length > 0) {
      const space = maxChars - currentLength;
      const nextChunk = remainingData.slice(0, space);
      currentParts.push({ eventId: part.eventId, length: nextChunk.length });
      currentLength += nextChunk.length;
      currentData += nextChunk;
      remainingData = remainingData.slice(nextChunk.length);

      if (currentLength >= maxChars) {
        items.push({ data: currentData, length: currentLength, parts: currentParts });
        currentParts = [];
        currentLength = 0;
        currentData = '';
      }
    }
  }

  if (currentLength > 0) {
    items.push({ data: currentData, length: currentLength, parts: currentParts });
  }

  return items;
}

function coalesceRendererQueuedMessages(queue, maxChars) {
  if (queue.length === 0) {
    return null;
  }

  const parts = [];
  let count = 0;
  let data = '';
  let length = 0;

  while (count < queue.length) {
    const next = queue[count];
    if (length + next.length > maxChars) {
      break;
    }

    parts.push(...next.parts);
    data += next.data;
    length += next.length;
    count += 1;
  }

  if (length === 0) {
    return null;
  }

  return { count, item: { data, length, parts } };
}

function collectRendererSends(strategy, scenario, sendLatencyMs) {
  const events = scenario.events.map((event, index) => ({
    ...event,
    id: index,
  }));
  const sends = [];
  let nextEventIndex = 0;
  let currentTime = 0;
  let flushAt = null;
  let sendAt = null;
  let pendingLength = 0;
  let pendingLimit = DEFAULT_MAX_PENDING_CHARS;
  let pendingParts = [];
  const queue = [];
  let activeSend = null;

  function flushPending() {
    flushAt = null;
    if (pendingLength === 0) {
      return;
    }

    const items = strategy.chunkBeforeQueue
      ? splitRendererQueuedMessages(pendingParts, MAX_SEND_BATCH_CHARS)
      : [{ data: pendingParts.map((part) => part.data).join(''), length: pendingLength, parts: pendingParts }];
    queue.push(...items);
    pendingParts = [];
    pendingLength = 0;
    pendingLimit = DEFAULT_MAX_PENDING_CHARS;
    maybeStartSend();
  }

  function maybeStartSend() {
    if (sendAt !== null || queue.length === 0) {
      return;
    }

    const next = strategy.coalesceQueue
      ? coalesceRendererQueuedMessages(queue, MAX_SEND_BATCH_CHARS)
      : { count: 1, item: queue[0] };
    if (!next || !next.item) {
      return;
    }

    activeSend = next;
    sendAt = currentTime + sendLatencyMs;
  }

  function finishSend() {
    if (!activeSend) {
      return;
    }

    const { count, item } = activeSend;
    sendAt = null;
    activeSend = null;
    queue.splice(0, count);
    sends.push({ ...item, timeMs: currentTime });
    maybeStartSend();
  }

  function enqueueEvent(event) {
    const plan = strategy.getPlan(event.data);
    pendingParts.push({ data: event.data, eventId: event.id });
    pendingLength += event.data.length;
    pendingLimit = Math.max(pendingLimit, plan.maxPendingChars);

    if (plan.flushImmediately || pendingLength >= pendingLimit) {
      flushPending();
      return;
    }

    if (flushAt === null || strategy.rescheduleFlush) {
      flushAt = currentTime + plan.flushDelayMs;
    }
  }

  while (
    nextEventIndex < events.length ||
    flushAt !== null ||
    sendAt !== null ||
    pendingLength > 0 ||
    queue.length > 0
  ) {
    const nextEventAt = events[nextEventIndex]?.timeMs ?? Number.POSITIVE_INFINITY;
    const nextFlushAt = flushAt ?? Number.POSITIVE_INFINITY;
    const nextSendAt = sendAt ?? Number.POSITIVE_INFINITY;
    currentTime = Math.min(nextEventAt, nextFlushAt, nextSendAt);

    if (currentTime === nextEventAt) {
      enqueueEvent(events[nextEventIndex]);
      nextEventIndex += 1;
      continue;
    }

    if (currentTime === nextFlushAt) {
      flushPending();
      continue;
    }

    if (currentTime === nextSendAt) {
      finishSend();
    }
  }

  return {
    events,
    sends,
  };
}

function runPipelineScenario(strategy, scenario, sendLatencyMs) {
  const renderer = collectRendererSends(
    strategies.hybrid4msSafeCoalesced,
    scenario,
    sendLatencyMs,
  );
  const remainingByEvent = new Map(renderer.events.map((event) => [event.id, event.data.length]));
  const completionByEvent = new Map();
  let currentTime = 0;
  let nextSendIndex = 0;
  let backendFlushAt = null;
  let backendWriteCount = 0;
  let maxQueuedChars = 0;
  const backendQueue = [];
  let backendQueuedChars = 0;

  function updateMaxQueuedChars() {
    if (backendQueuedChars > maxQueuedChars) {
      maxQueuedChars = backendQueuedChars;
    }
  }

  function applyCompletedParts(parts) {
    for (const part of parts) {
      const remaining = remainingByEvent.get(part.eventId);
      if (remaining === undefined) {
        continue;
      }
      const nextRemaining = remaining - part.length;
      if (nextRemaining <= 0) {
        remainingByEvent.delete(part.eventId);
        completionByEvent.set(part.eventId, currentTime);
      } else {
        remainingByEvent.set(part.eventId, nextRemaining);
      }
    }
  }

  function flushBackendQueue() {
    backendFlushAt = null;
    while (backendQueue.length > 0) {
      const nextBatch = coalesceRendererQueuedMessages(backendQueue, strategy.maxBatchChars);
      if (!nextBatch || !nextBatch.item) {
        return;
      }

      backendQueue.splice(0, nextBatch.count);
      backendQueuedChars -= nextBatch.item.length;
      backendWriteCount += 1;
      applyCompletedParts(nextBatch.item.parts);
    }
    backendQueuedChars = 0;
  }

  function enqueueBackendMessage(message) {
    if (strategy.flushDelayMs === null) {
      backendWriteCount += 1;
      applyCompletedParts(message.parts);
      return;
    }

    backendQueue.push(message);
    backendQueuedChars += message.length;
    updateMaxQueuedChars();

    if (backendQueuedChars >= strategy.maxBatchChars || hasImmediateFlushInput(message.data)) {
      flushBackendQueue();
      return;
    }

    if (backendFlushAt === null) {
      backendFlushAt = currentTime + strategy.flushDelayMs;
    }
  }

  while (nextSendIndex < renderer.sends.length || backendFlushAt !== null || backendQueue.length > 0) {
    const nextSendAt = renderer.sends[nextSendIndex]?.timeMs ?? Number.POSITIVE_INFINITY;
    const nextBackendFlushAt = backendFlushAt ?? Number.POSITIVE_INFINITY;
    currentTime = Math.min(nextSendAt, nextBackendFlushAt);

    if (currentTime === nextSendAt) {
      enqueueBackendMessage(renderer.sends[nextSendIndex]);
      nextSendIndex += 1;
      continue;
    }

    if (currentTime === nextBackendFlushAt) {
      flushBackendQueue();
    }
  }

  const latenciesByEvent = renderer.events.map((event) => (completionByEvent.get(event.id) ?? currentTime) - event.timeMs);

  return {
    backendWriteCount,
    latency: summarize(latenciesByEvent),
    maxQueuedChars,
    rendererSendCount: renderer.sends.length,
    totalDurationMs: currentTime,
  };
}

function printPipelineResult(strategyName, scenarioName, sendLatencyMs, result) {
  console.log(
    [
      strategyName.padEnd(18),
      scenarioName.padEnd(18),
      `${sendLatencyMs}ms`.padEnd(6),
      `renderer=${String(result.rendererSendCount).padStart(3)}`,
      `pty=${String(result.backendWriteCount).padStart(3)}`,
      `done=${String(Math.round(result.totalDurationMs)).padStart(5)}ms`,
      `p95=${String(Math.round(result.latency.p95)).padStart(4)}ms`,
      `maxQ=${String(result.maxQueuedChars).padStart(5)}`,
    ].join('  '),
  );
}

console.log('Pipeline benchmark (hybrid 4ms renderer + backend PTY queue)');
console.log(`Backend queue candidates: ${backendStrategies.map((strategy) => strategy.name).join(', ')}`);
console.log('');

const pipelineScenarios = scenarios.filter((scenario) => scenario.name !== 'typing');
const pipelineLatencies = [0, 1, 5];

for (const strategy of backendStrategies) {
  for (const scenario of pipelineScenarios) {
    for (const sendLatencyMs of pipelineLatencies) {
      const result = runPipelineScenario(strategy, scenario, sendLatencyMs);
      printPipelineResult(strategy.name, scenario.name, sendLatencyMs, result);
    }
  }
  console.log('');
}
