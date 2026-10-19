"use strict";
// Shipped CommonJS asset. Hosts the attachment parser worker in its own OS process so a
// native parser crash (for example in the canvas addon) cannot take down Relay Desk.
const { Worker } = require("node:worker_threads");

let worker;
let finished = false;
const finish = reply => {
  if (finished) return;
  finished = true;
  // Exit the whole process instead of terminating the worker: some native addons crash
  // when their worker thread is torn down, and the process is disposable anyway.
  process.send(reply, () => process.exit(0));
};

process.on("message", message => {
  if (message === "cancel") {
    worker?.postMessage("cancel");
    setTimeout(() => process.exit(0), 100).unref();
    return;
  }
  if (worker || !message || typeof message !== "object") return;
  worker = new Worker(message.workerPath, { workerData: message.workerData, resourceLimits: message.resourceLimits, env: process.env });
  worker.once("message", result => finish({ type: "result", result }));
  worker.once("error", () => finish({ type: "error" }));
  worker.once("exit", () => finish({ type: "exit" }));
});
process.on("disconnect", () => process.exit(0));
