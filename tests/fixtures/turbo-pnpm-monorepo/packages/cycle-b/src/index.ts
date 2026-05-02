import { fromA } from "@org/cycle-a";

export function fromB(): string {
  return "b:" + fromA();
}
