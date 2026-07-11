// Socket.IO realtime — order status updates to the student's mobile app.
import { Server } from "socket.io";

let io: Server;

export function initRealtime(server: Server) {
  io = server;
  io.on("connection", (socket) => {
    // Client joins a room for its userId to receive its own order updates.
    socket.on("subscribe", (userId: string) => socket.join(`user:${userId}`));
  });
}

export function emitOrderUpdate(userId: string, orderId: string, status: string) {
  if (!io) return;
  io.to(`user:${userId}`).emit("order:update", { orderId, status });
}

export function emitNotification(userId: string, notification: unknown) {
  if (!io) return;
  io.to(`user:${userId}`).emit("notification:new", notification);
}
