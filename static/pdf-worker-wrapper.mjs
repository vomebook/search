if (!Map.prototype.getOrInsertComputed) {
  Map.prototype.getOrInsertComputed = function(key, callback) {
    if (this.has(key)) return this.get(key);
    const value = callback(key);
    this.set(key, value);
    return value;
  };
}
if (!Math.sumPrecise) {
  Math.sumPrecise = function(values) {
    let sum = 0;
    let correction = 0;
    for (const value of values) {
      const next = sum + value;
      correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
      sum = next;
    }
    return sum + correction;
  };
}

const pendingMessages = [];
const bufferMessage = event => pendingMessages.push(event);
self.addEventListener("message", bufferMessage);

import("./vendor/pdf.worker.min.0613f41490dd.mjs").then(() => {
  self.removeEventListener("message", bufferMessage);
  for (const event of pendingMessages) self.dispatchEvent(new MessageEvent("message", { data: event.data }));
});
