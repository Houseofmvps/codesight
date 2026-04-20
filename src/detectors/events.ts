/**
 * Event, job queue, and pub/sub detector.
 * Detects: BullMQ queues, Kafka topics, Redis pub/sub, Socket.io namespaces,
 * Node.js EventEmitter events.
 */

import { relative } from "node:path";
import { readFileSafe } from "../scanner.js";
import type { EventInfo, ProjectInfo } from "../types.js";

export async function detectEvents(
  files: string[],
  project: ProjectInfo
): Promise<EventInfo[]> {
  const events: EventInfo[] = [];

  const relevantFiles = files.filter(
    (f) => /\.(ts|tsx|js|jsx|mjs|py|rb|ex|exs|brs|bs)$/.test(f) && !f.includes("node_modules")
  );

  for (const file of relevantFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    const rel = relative(project.root, file).replace(/\\/g, "/");

    // BullMQ: new Queue('queue-name', ...) / new Worker('queue-name', ...)
    const bullmqPattern = /new\s+(?:Queue|Worker|FlowProducer)\s*\(\s*["'`]([^"'`]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = bullmqPattern.exec(content)) !== null) {
      events.push({
        name: m[1],
        type: "queue",
        system: "bullmq",
        file: rel,
      });
    }

    // BullMQ job.add: queue.add('job-name', ...) — job names within a queue
    const bullJobPattern = /\.add\s*\(\s*["'`]([^"'`]+)["'`]\s*,/g;
    while ((m = bullJobPattern.exec(content)) !== null) {
      if (content.includes("Queue") || content.includes("Worker")) {
        events.push({
          name: m[1],
          type: "queue",
          system: "bullmq",
          file: rel,
        });
      }
    }

    // Kafka: producer.send({ topic: 'name' }) / kafka.consumer({ groupId }) + consumer.subscribe({ topic })
    const kafkaTopicPattern = /topic\s*:\s*["'`]([^"'`]+)["'`]/g;
    if (content.includes("kafka") || content.includes("Kafka")) {
      while ((m = kafkaTopicPattern.exec(content)) !== null) {
        events.push({
          name: m[1],
          type: "topic",
          system: "kafka",
          file: rel,
        });
      }
    }

    // Redis pub/sub: redis.publish('channel', ...) / redis.subscribe('channel')
    const redisPubSubPattern = /(?:publish|subscribe|psubscribe)\s*\(\s*["'`]([^"'`]+)["'`]/g;
    if (content.includes("redis") || content.includes("Redis") || content.includes("ioredis")) {
      while ((m = redisPubSubPattern.exec(content)) !== null) {
        events.push({
          name: m[1],
          type: "channel",
          system: "redis-pub-sub",
          file: rel,
        });
      }
    }

    // Node EventEmitter: emitter.emit('event-name') / emitter.on('event-name')
    const emitterPattern = /(?:emit|on|once|addListener)\s*\(\s*["'`]([^"'`]+)["'`]/g;
    if (content.includes("EventEmitter") || content.includes(".emit(") || content.includes("eventBus")) {
      while ((m = emitterPattern.exec(content)) !== null) {
        const eventName = m[1];
        // Skip DOM-like events and Socket.io lifecycle events
        if (["error", "close", "connect", "disconnect", "connection", "data", "end", "drain"].includes(eventName)) continue;
        events.push({
          name: eventName,
          type: "event",
          system: "eventemitter",
          file: rel,
        });
      }
    }

    // Python Celery: @app.task / @shared_task + apply_async('task-name')
    if (file.endsWith(".py") && (content.includes("celery") || content.includes("Celery"))) {
      const celeryTaskPat = /@(?:app\.task|shared_task|celery\.task)[\s\S]{0,100}def\s+(\w+)/g;
      while ((m = celeryTaskPat.exec(content)) !== null) {
        events.push({
          name: m[1],
          type: "queue",
          system: "bullmq", // map to closest JS equivalent concept for display
          file: rel,
          payloadType: "celery-task",
        });
      }
    }

    // Elixir: Phoenix.PubSub.broadcast / PubSub.subscribe
    if (file.endsWith(".ex") || file.endsWith(".exs")) {
      const elixirPubSubPat = /PubSub\.(?:broadcast|subscribe)\s*\([^,]+,\s*"([^"]+)"/g;
      while ((m = elixirPubSubPat.exec(content)) !== null) {
        events.push({
          name: m[1],
          type: "channel",
          system: "redis-pub-sub",
          file: rel,
        });
      }
    }

    // Roku SceneGraph: observeField subscriptions + RudderstackTask events.
    // Every observed field is a reactive-style event bus inside the scene
    // graph; Rudderstack events are the analytics topic stream for the app.
    if (file.endsWith(".brs") || file.endsWith(".bs")) {
      const { extractBrightScriptObservers, extractBrightScriptRudderstackEvents } =
        await import("../ast/extract-brightscript.js");

      for (const obs of extractBrightScriptObservers(content)) {
        events.push({
          name: obs.field,
          type: "event",
          system: "scenegraph-observer",
          file: rel,
          payloadType: obs.scope === "global" ? "m.global" : "node-field",
        });
      }

      for (const evt of extractBrightScriptRudderstackEvents(content)) {
        events.push({
          name: evt.name,
          type: "topic",
          system: "rudderstack",
          file: rel,
        });
      }
    }
  }

  // Deduplicate by name + system + type (keep first occurrence)
  const seen = new Set<string>();
  return events.filter((e) => {
    const key = `${e.system}:${e.type}:${e.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
