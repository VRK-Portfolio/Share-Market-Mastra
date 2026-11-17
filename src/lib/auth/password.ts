import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}
export const passwordHashPattern = /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/;
export async function hashTerminalPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyTerminalPassword(password: string, hash: string) {
  if (!passwordHashPattern.test(hash)) throw new Error("Terminal password hash is not configured correctly.");
  const [, salt, expected] = hash.split(":");
  return timingSafeEqual(await derive(password, salt), Buffer.from(expected, "hex"));
}
