// MQTT bridge — backend <-> IoT print agents (Raspberry Pi).
// Topics:
//   printhub/printer/{deviceId}/job     -> backend publishes print job
//   printhub/printer/{deviceId}/status  -> device publishes status/telemetry
import mqtt, { MqttClient } from "mqtt";
import { prisma } from "./prisma";
import { config } from "./config";

let client: MqttClient;

export function initMqtt(onJobUpdate: (payload: any) => void) {
  // mqtt.connect handles mqtts:// (TLS) and user:pass@host auth from the URL.
  client = mqtt.connect(config.mqttUrl, { reconnectPeriod: 3000 });

  client.on("connect", () => {
    console.log("[mqtt] connected");
    client.subscribe("printhub/printer/+/status");
    client.subscribe("printhub/printer/+/job-result");
  });

  client.on("message", async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (topic.endsWith("/status")) {
        await handleStatus(payload);
      } else if (topic.endsWith("/job-result")) {
        onJobUpdate(payload);
      }
    } catch (e) {
      console.error("[mqtt] bad message", topic, e);
    }
  });

  return client;
}

async function handleStatus(p: {
  deviceId: string;
  status?: string;
  paperLevel?: number;
  tonerLevel?: number;
}) {
  await prisma.printer.updateMany({
    where: { deviceId: p.deviceId },
    data: {
      status: (p.status as any) || undefined,
      paperLevel: p.paperLevel,
      tonerLevel: p.tonerLevel,
      lastSeenAt: new Date(),
    },
  });
}

// Push a print command to a specific device.
export function publishJob(deviceId: string, job: unknown) {
  client.publish(`printhub/printer/${deviceId}/job`, JSON.stringify(job), { qos: 1 });
}
