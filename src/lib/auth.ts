import jwt from "jsonwebtoken";
import { config } from "./config";

const SECRET = config.jwtSecret;

export interface JwtPayload {
  userId: string;
  role: string;
}

export function signToken(payload: JwtPayload) {
  return jwt.sign(payload, SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, SECRET) as JwtPayload;
}
