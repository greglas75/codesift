"use server";
import { z } from "zod";

const schema = z.object({ id: z.string() });

export async function noAuthAction(input: unknown) {
  const data = schema.parse(input);
  return data;
}
