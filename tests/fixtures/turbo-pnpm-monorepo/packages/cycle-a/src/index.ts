import { fromB } from "@org/cycle-b";

export function fromA(): string {
  return "a:" + fromB();
}
