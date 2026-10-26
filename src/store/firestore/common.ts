import { Timestamp } from "@google-cloud/firestore";

/** gRPC のステータスコード。 */
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;

function grpcCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

export function isAlreadyExists(err: unknown): boolean {
  return grpcCode(err) === GRPC_ALREADY_EXISTS;
}

export function isNotFound(err: unknown): boolean {
  return grpcCode(err) === GRPC_NOT_FOUND;
}

/** Firestore の Timestamp（またはすでに Date）を Date にする。 */
export function toDate(value: unknown): Date {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  throw new Error("expireAt が Timestamp ではありません");
}

/** 保存された文書の expireAt（Timestamp）を Date に直す。 */
export function withExpireAtAsDate<T extends { expireAt: Date }>(data: Record<string, unknown>): T {
  return { ...data, expireAt: toDate(data.expireAt) } as unknown as T;
}
