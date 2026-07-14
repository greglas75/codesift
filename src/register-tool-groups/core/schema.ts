import { z } from "../shared.js";

export function zJsonArray<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.string().transform((value, context): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected a JSON array",
      });
      return z.NEVER;
    }
  }).pipe(z.array(itemSchema));
}
