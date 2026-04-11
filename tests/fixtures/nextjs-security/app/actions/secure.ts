"use server";
import { z } from "zod";

const schema = z.object({ name: z.string() });

export async function secureAction(input: unknown) {
  const session = await auth();
  if (!session) throw new Error("unauthorized");
  const data = schema.parse(input);
  await ratelimit.limit(session.userId);
  try {
    return data;
  } catch (e) {
    throw e;
  }
}
