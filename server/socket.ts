import { Server } from "socket.io";
import { type Server as HttpServer } from "http";
import { expressLogger } from "./logger.js";
import { config } from "./config.js";
import { logEmitter } from "./log-events.js";
import { resolveSocketUser } from "./auth.js";

let io: Server | undefined;

/** Room prefix that binds a socket to the authenticated user it belongs to. */
const USER_ROOM_PREFIX = "user:";

export function setupSocketIO(httpServer: HttpServer) {
  if (!io) {
    io = new Server({
      path: `${config.server.basePath}/socket.io/`,
      cors: {
        origin:
          config.server.allowedOrigins.length === 1 && config.server.allowedOrigins[0] === "*"
            ? "*"
            : config.server.allowedOrigins,
        methods: ["GET", "POST"],
      },
    });

    // Bind identity during the handshake rather than in the connection handler:
    // by the time the client is told it is connected, its socket is already in
    // the room, so a notification fired immediately after connect cannot be
    // dropped while the join is still in flight.
    io.use((socket, next) => {
      resolveSocketUser(socket.handshake)
        .then((user) => {
          if (user) {
            socket.data.userId = user.id;
            socket.join(`${USER_ROOM_PREFIX}${user.id}`);
          }
          next();
        })
        // An unresolved handshake must not stall the connection forever; such a
        // socket simply stays anonymous and receives no user-scoped events.
        .catch(() => next());
    });

    io.on("connection", (socket) => {
      const userId = socket.data.userId as string | undefined;
      expressLogger.info(
        { socketId: socket.id, userId },
        userId ? "Client connected to WebSocket" : "Anonymous client connected to WebSocket"
      );

      socket.on("disconnect", () => {
        expressLogger.info({ socketId: socket.id }, "Client disconnected from WebSocket");
      });
    });

    logEmitter.on("line", (line: string) => {
      io!.emit("logLine", line);
    });
  }

  io.attach(httpServer);

  return io;
}

export function getIO() {
  if (!io) {
    throw new Error("Socket.IO not initialized!");
  }
  return io;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function notifyUser(type: string, payload: any, userId?: string | null) {
  if (!io) {
    return;
  }

  if (userId) {
    // Owner known: reach only that user's sockets.
    io.to(`${USER_ROOM_PREFIX}${userId}`).emit(type, payload);
    return;
  }

  // No owner (anonymous or app-wide event): broadcast, as before.
  io.emit(type, payload);
}
