/**
 * eventLoopMonitor.js
 *
 * Lightweight event-loop-delay / GC-pause monitor, used to correlate RTP
 * pacing anomalies (see [RTP PACING STATS] in PromoSoftSipClient.js) with
 * Node.js runtime behaviour before attributing timing variation to the OS
 * scheduler. Backed by perf_hooks.monitorEventLoopDelay(), which samples via
 * a native histogram (no per-tick JS callback), so overhead is negligible
 * even sampled continuously.
 */

const { monitorEventLoopDelay, PerformanceObserver, constants } = require("node:perf_hooks");

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

let gcCount = 0;
let gcTotalMs = 0;
let gcMaxMs = 0;

const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcCount++;
    gcTotalMs += entry.duration;
    if (entry.duration > gcMaxMs) gcMaxMs = entry.duration;
  }
});
gcObserver.observe({ entryTypes: ["gc"] });

/**
 * Returns event-loop-delay and GC stats accumulated since the last call
 * (or since process start, on the first call), then resets both for the
 * next window. Intended to be called once per RTP pacing-stats window
 * (~every 500 packets / ~10s), not per-packet.
 */
function snapshot() {
  const result = {
    elDelayMinMs:    histogram.min / 1e6,
    elDelayMaxMs:    histogram.max / 1e6,
    elDelayMeanMs:   histogram.mean / 1e6,
    elDelayStddevMs: histogram.stddev / 1e6,
    elDelayP95Ms:    histogram.percentile(95) / 1e6,
    gcCount,
    gcTotalMs,
    gcMaxMs,
  };
  histogram.reset();
  gcCount = 0;
  gcTotalMs = 0;
  gcMaxMs = 0;
  return result;
}

module.exports = { snapshot };
