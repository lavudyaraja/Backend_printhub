import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
const prisma = new PrismaClient();

async function main() {
  // Admin login for the web dashboard — phone 9999999999 / password admin123.
  const adminHash = await bcrypt.hash("admin123", 10);
  await prisma.user.upsert({
    where: { phone: "9999999999" },
    update: { role: "ADMIN", passwordHash: adminHash },
    create: { phone: "9999999999", email: "admin@printhub.edu", name: "Admin", role: "ADMIN", passwordHash: adminHash },
  });

  // Central University of Haryana, Mahendergarh campus kiosks.
  const kiosks = [
    { deviceId: "cuh-library-01", name: "PrintHub Kiosk – Central Library", location: "Central Library, Central University of Haryana, Mahendergarh", status: "ONLINE" as const, paperLevel: 92, tonerLevel: 78 },
    { deviceId: "cuh-acadblock-01", name: "PrintHub Kiosk – Academic Block", location: "Academic Block, Central University of Haryana, Mahendergarh", status: "ONLINE" as const, paperLevel: 64, tonerLevel: 55 },
    { deviceId: "cuh-hostel-01", name: "PrintHub Kiosk – Boys Hostel", location: "Boys Hostel, Central University of Haryana, Mahendergarh", status: "BUSY" as const, paperLevel: 40, tonerLevel: 33 },
    { deviceId: "cuh-admin-01", name: "PrintHub Kiosk – Admin Block", location: "Administrative Block, Central University of Haryana, Mahendergarh", status: "OFFLINE" as const, paperLevel: 0, tonerLevel: 12 },
  ];
  for (const k of kiosks) {
    await prisma.printer.upsert({ where: { deviceId: k.deviceId }, update: { name: k.name, location: k.location, status: k.status, paperLevel: k.paperLevel, tonerLevel: k.tonerLevel }, create: k });
  }
  // Remove the old placeholder kiosk if present (ignore if referenced by orders).
  try {
    await prisma.printer.deleteMany({ where: { deviceId: "kiosk-lib-01" } });
    await prisma.printer.deleteMany({ where: { deviceId: "cuh-boyshostel-01" } });
  } catch {
    await prisma.printer.updateMany({ where: { deviceId: "kiosk-lib-01" }, data: { status: "OFFLINE" } });
    await prisma.printer.updateMany({ where: { deviceId: "cuh-boyshostel-01" }, data: { status: "OFFLINE" } });
  }

  console.log("Seed complete.");
}

main().finally(() => prisma.$disconnect());
